#!/usr/bin/env python3
"""
Buzzkill speaker: reads the roasts out loud on the Pi's Bluetooth speaker.

  python3 speaker.py           run it (Ctrl+C to stop)
  python3 speaker.py --test    say one roast and quit (checks the speaker works)

What it does, about twice a second:
  1. Finds the open game whose host picked this speaker (games.speaker = SPEAKER_ID).
  2. Reads that game's players from `results`.
  3. Plays a roast on loop while anyone has alarm_on and is NOT shaking. Otherwise silent.
Every 5 seconds it checks in (speakers.last_seen) so the host page shows "Speaker online".

Settings come from hardware/.env (see .env.example). Only needs `requests` and `espeak-ng`.
"""
import os
import random
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROASTS = [
    "{n} picked up their phone. Your future self is disappointed.",
    "Attention everyone. {n} could not last. Shake it off, {n}.",
    "{n} is doomscrolling again. Put it down.",
    "Wow {n}. That notification was not important.",
]

POLL_SECS = 0.5
HEARTBEAT_SECS = 5
SHAKE_TIMEOUT = 2.0      # no new shake for 2s while is_shaking = their phone died, play the sound


# ---------- settings from .env ----------
def load_env():
    env_file = Path(__file__).with_name(".env")
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()
URL = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SERVICE_KEY"]
SPEAKER_ID = os.environ.get("SPEAKER_ID", "brick")
SPEAKER_NAME = os.environ.get("SPEAKER_NAME", "Buzzkill speaker")
BT_MAC = os.environ.get("BT_SPEAKER_MAC", "").strip()
TTS_CMD = os.environ.get("TTS_CMD", "espeak-ng -v en-us -s 160 -a 200").split()

http = requests.Session()
http.headers.update({"apikey": KEY, "Content-Type": "application/json"})


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------- Supabase (plain REST, no SDK needed) ----------
def get(table, **params):
    r = http.get(f"{URL}/{table}", params=params, timeout=5)
    r.raise_for_status()
    return r.json()


def heartbeat():
    r = http.post(f"{URL}/speakers",
                  headers={"Prefer": "resolution=merge-duplicates"},
                  json={"id": SPEAKER_ID, "name": SPEAKER_NAME,
                        "last_seen": datetime.now(timezone.utc).isoformat()},
                  timeout=5)
    r.raise_for_status()


def current_game():
    """The open game that picked this speaker. A live game wins over one still waiting."""
    games = get("games", select="code,status", speaker=f"eq.{SPEAKER_ID}",
                status="in.(waiting,live)")
    games.sort(key=lambda g: g["status"] != "live")
    return games[0] if games else None


# ---------- Bluetooth: keep the speaker connected ----------
def bluetooth_loop():
    while True:
        try:
            info = subprocess.run(["bluetoothctl", "info", BT_MAC],
                                  capture_output=True, text=True, timeout=10).stdout
            if "Connected: yes" not in info:
                log("Bluetooth speaker not connected, connecting to", BT_MAC)
                subprocess.run(["bluetoothctl", "connect", BT_MAC],
                               capture_output=True, timeout=20)
        except Exception as e:
            log("Bluetooth check failed:", e)
        time.sleep(10)


# ---------- Talking ----------
class Voice:
    def __init__(self):
        self.proc = None
        self.who = None          # user_id being roasted right now

    def busy(self):
        return self.proc is not None and self.proc.poll() is None

    def say(self, text, who=None):
        self.stop()
        log("Saying:", text)
        self.proc = subprocess.Popen(TTS_CMD + [text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.who = who

    def stop(self):
        if self.busy():
            self.proc.kill()
            self.proc.wait()
        self.proc = None
        self.who = None


def main():
    voice = Voice()

    if "--test" in sys.argv:
        voice.say(ROASTS[0].format(n="Test"))
        voice.proc.wait()
        return

    if BT_MAC:
        threading.Thread(target=bluetooth_loop, daemon=True).start()

    log(f"Speaker '{SPEAKER_ID}' running. Pick it on the host page to use it.")
    voice.say("Buzzkill speaker ready.")
    voice.proc.wait()

    code = None
    last_heartbeat = 0
    shake_seen = {}      # user_id -> (last_shake_at value, when we first saw it on this Pi's clock)

    while True:
        try:
            now = time.monotonic()
            if now - last_heartbeat > HEARTBEAT_SECS:
                heartbeat()
                last_heartbeat = now

            game = current_game()
            if not game or game["status"] != "live":
                if game and game["code"] != code:
                    log("Following game", game["code"], "(waiting for it to start)")
                code = game["code"] if game else None
                voice.stop()
                time.sleep(POLL_SECS)
                continue
            if game["code"] != code:
                code = game["code"]
                log("Game", code, "is live")

            players = get("results", game=f"eq.{code}",
                          select="user_id,alarm_on,is_shaking,last_shake_at,profiles(username)")

            # Sound plays when your alarm is on and you're NOT shaking.
            # Still "shaking" but no new shake for 2s (phone died, lost signal) = stopped.
            loud = []
            for p in players:
                uid = p["user_id"]
                if shake_seen.get(uid, (None,))[0] != p["last_shake_at"]:
                    shake_seen[uid] = (p["last_shake_at"], now)
                shaking_now = p["is_shaking"] and now - shake_seen[uid][1] < SHAKE_TIMEOUT
                if p["alarm_on"] and not shaking_now:
                    loud.append(p)

            loud_ids = {p["user_id"] for p in loud}
            if voice.who and voice.who not in loud_ids:
                voice.stop()             # they started shaking: cut the roast off right away
            if not loud:
                voice.stop()
            elif not voice.busy():
                p = random.choice(loud)
                name = (p.get("profiles") or {}).get("username") or "Someone"
                voice.say(random.choice(ROASTS).format(n=name), p["user_id"])

        except requests.RequestException as e:
            log("Network problem:", e)
            time.sleep(2)

        time.sleep(POLL_SECS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
