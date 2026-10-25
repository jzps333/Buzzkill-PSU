"""
Buzzkill game brain. Runs on the Raspberry Pi.

What it does:
  - Touch sensor tap   -> new game (writes the join link to the NFC tag), then tap again to start
  - Touch sensor hold  -> end the game, pay out, announce the winner
  - Listens to Supabase live:
        join      -> adds the player to the game
        pickup    -> +1 pickup, roast plays on the speaker (on loop)
        shake     -> stops the roast (only the guilty person's shake works)

Run:  python3 game.py
Needs hardware/.env with SUPABASE_URL and SUPABASE_SERVICE_KEY (see .env.example).
"""

import asyncio
import os
import random
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import acreate_client

load_dotenv(Path(__file__).with_name(".env"))

SITE = os.environ.get("SITE_URL", "https://buzzkill-psu.vercel.app")
MIN_PLAYERS = int(os.environ.get("MIN_PLAYERS", "4"))
PENALTY = 0.02          # SOL lost per pickup


# ---------- 1. Hardware ----------
# The hardware team puts the real code in brick.py with these 4 functions:
#   write_tag(url)              -> write the join link to the NFC tag
#   play(path_or_text, loop)    -> play a sound / roast on the speaker
#   stop()                      -> stop the speaker
#   watch_touch(on_tap, on_hold)-> call on_tap / on_hold when the sensor is touched
# Until then, these fake versions print to the screen so the game still runs.
try:
    import brick
except ImportError:
    class brick:
        _proc = None

        @staticmethod
        def write_tag(url):
            print("[NFC] tag ->", url)

        @staticmethod
        def play(text, loop=False):
            brick.stop()
            print("[SPEAKER]", text, "(looping)" if loop else "")
            cmd = f'while true; do espeak-ng "{text}"; sleep 1; done' if loop else f'espeak-ng "{text}"'
            brick._proc = subprocess.Popen(["bash", "-c", cmd], start_new_session=True,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        @staticmethod
        def stop():
            if brick._proc and brick._proc.poll() is None:
                os.killpg(brick._proc.pid, 15)
            brick._proc = None

        @staticmethod
        def watch_touch(on_tap, on_hold):
            print("[TOUCH] no sensor yet: press Enter = tap, type 'h' + Enter = hold")
            import threading

            def keyboard():
                while True:
                    (on_hold if input().strip().lower() == "h" else on_tap)()
            threading.Thread(target=keyboard, daemon=True).start()


ROASTS = [
    "{n} picked up their phone. Your future self is disappointed.",
    "Attention everyone. {n} could not last. Shake it off, {n}.",
    "{n} is doomscrolling again. Put it down.",
    "Wow {n}. That notification was not important.",
]


# ---------- 2. Game state ----------
class Game:
    def __init__(self, db):
        self.db = db
        self.code = None
        self.status = "idle"     # idle / waiting / live / ended
        self.alarms = []         # people being roasted, in order
        self.names = {}          # user_id -> username

    def now(self):
        return datetime.now(timezone.utc).isoformat()

    async def name(self, uid):
        if uid not in self.names:
            r = await self.db.table("profiles").select("username").eq("id", uid).single().execute()
            self.names[uid] = r.data["username"]
        return self.names[uid]

    async def players(self):
        r = await self.db.table("results").select("*").eq("game", self.code).execute()
        return r.data

    # ----- touch: tap -----
    async def on_tap(self):
        if self.status in ("idle", "ended"):
            self.code = secrets.token_hex(3).upper()           # e.g. 4F2A9C
            self.alarms, self.names = [], {}
            await self.db.table("games").insert({"code": self.code}).execute()
            self.status = "waiting"
            brick.write_tag(f"{SITE}/join?room={self.code}")
            brick.play("Tap your phones on the brick to join.")
            print(f"New game {self.code}")

        elif self.status == "waiting":
            count = len(await self.players())
            if count < MIN_PLAYERS:
                brick.play(f"{count} players. You need {MIN_PLAYERS}. Find more friends.")
                return
            await self.db.table("games").update({"status": "live", "start_time": self.now()}) \
                .eq("code", self.code).execute()
            self.status = "live"
            brick.play("Phones face down. Game on. Good luck.")
            print("Game started")

    # ----- touch: hold -----
    async def on_hold(self):
        if self.status != "live":
            return
        self.status = "ended"
        self.alarms = []
        brick.stop()

        ps = await self.players()
        for uid, back in payouts(ps).items():
            await self.db.table("results").update({"sol_back": back}) \
                .eq("game", self.code).eq("user_id", uid).execute()
        await self.db.table("games").update({"status": "ended", "end_time": self.now()}) \
            .eq("code", self.code).execute()

        if ps:
            best = min(ps, key=lambda p: p["pickups"])
            worst = max(ps, key=lambda p: p["pickups"])
            brick.play(f"Game over. {await self.name(best['user_id'])} wins. "
                       f"{await self.name(worst['user_id'])}, {worst['pickups']} pickups. Seek help.")
        brick.write_tag(f"{SITE}/join?room=closed")
        print("Game ended")

    # ----- live events from phones -----
    async def on_event(self, ev):
        if ev.get("game") != self.code:
            return
        uid, kind = ev["user_id"], ev["type"]

        if kind == "join" and self.status == "waiting":
            await self.db.table("results").upsert({"game": self.code, "user_id": uid},
                                                   ignore_duplicates=True).execute()
            print("Joined:", await self.name(uid))

        elif kind in ("pickup", "left_page") and self.status == "live":
            if uid in self.alarms:                          # already being roasted: don't count twice
                return
            r = await self.db.table("results").select("pickups") \
                .eq("game", self.code).eq("user_id", uid).maybe_single().execute()
            if not r or not r.data:                         # not in this game
                return
            await self.db.table("results").update({"pickups": r.data["pickups"] + 1}) \
                .eq("game", self.code).eq("user_id", uid).execute()
            self.alarms.append(uid)
            print("PICKUP:", await self.name(uid))
            if len(self.alarms) == 1:
                await self.roast()

        elif kind == "shake" and self.alarms and self.alarms[0] == uid:
            brick.stop()
            self.alarms.pop(0)
            print("Shaken off:", await self.name(uid))
            if self.alarms:
                await self.roast()                          # next person in line

    async def roast(self):
        n = await self.name(self.alarms[0])
        brick.play(random.choice(ROASTS).format(n=n), loop=True)


# ---------- 3. Payouts ----------
def payouts(ps):
    """Who gets what back. Clean players (0 pickups) split what everyone else lost.
    If nobody is clean, everyone gets their stake back."""
    staked = [p for p in ps if float(p["sol_in"]) > 0]
    if not staked:
        return {}
    lost = {p["user_id"]: min(p["pickups"] * PENALTY, float(p["sol_in"])) for p in staked}
    clean = [p for p in staked if p["pickups"] == 0]
    if not clean:
        return {p["user_id"]: float(p["sol_in"]) for p in staked}
    pot = sum(lost.values())
    clean_total = sum(float(p["sol_in"]) for p in clean)
    out = {p["user_id"]: float(p["sol_in"]) - lost[p["user_id"]] for p in staked}
    for p in clean:
        out[p["user_id"]] += pot * float(p["sol_in"]) / clean_total
    return {k: round(v, 6) for k, v in out.items()}


# ---------- 4. Start everything ----------
async def main():
    db = await acreate_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    game = Game(db)
    loop = asyncio.get_running_loop()

    # Touch sensor runs in its own thread -> hand the work to the game safely
    brick.watch_touch(
        on_tap=lambda: asyncio.run_coroutine_threadsafe(game.on_tap(), loop),
        on_hold=lambda: asyncio.run_coroutine_threadsafe(game.on_hold(), loop),
    )

    # Supabase Realtime: run on_event for every new row in "events"
    def handle(payload):
        data = payload.get("data", payload)
        record = data.get("record") or data.get("new") or {}
        asyncio.run_coroutine_threadsafe(game.on_event(record), loop)

    await db.channel("events").on_postgres_changes(
        "INSERT", schema="public", table="events", callback=handle
    ).subscribe()

    print("Buzzkill is running. Tap the brick to start a game.")
    await asyncio.Event().wait()            # run forever


if __name__ == "__main__":
    asyncio.run(main())
