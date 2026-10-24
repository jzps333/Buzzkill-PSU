"""Buzzkill game server. Runs on the Raspberry Pi.

Phones open /       -> join, put phone face-down, get roasted if they pick it up
A laptop opens /board -> lobby, start button, live leaderboard
"""

import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

import roasts  # noqa: E402
from speech import Speaker  # noqa: E402

MIN_PLAYERS = int(os.getenv("MIN_PLAYERS", "4"))
PICKUP_PENALTY = 50       # points lost the moment you pick up your phone
ROAST_PENALTY = 10        # points lost every time the roast repeats
ROAST_REPEAT_SECONDS = 8  # how often the roast repeats until you shake
NAG_SECONDS = 45          # phone up (after shaking) this long -> roast starts again
LEAD_ANNOUNCE_GAP = 20    # don't announce lead changes more often than this

STATIC = Path(__file__).parent / "static"


class Player:
    def __init__(self, name):
        self.name = name
        self.ws = None
        self.ready = False
        self.down = False
        self.roasting = False
        self.score = 0
        self.pickups = 0
        self.next_roast_at = 0.0
        self.up_since = 0.0

    def public(self):
        return {
            "name": self.name,
            "connected": self.ws is not None,
            "ready": self.ready,
            "down": self.down,
            "roasting": self.roasting,
            "score": self.score,
            "pickups": self.pickups,
        }


class Game:
    def __init__(self, speaker):
        self.speaker = speaker
        self.players = {}
        self.boards = set()
        self.phase = "lobby"  # lobby -> running -> ended
        self.ends_at = 0.0
        self.leader = None
        self.last_lead_announce = 0.0

    # ---- state broadcast ----

    def snapshot(self):
        ranked = sorted(self.players.values(), key=lambda p: -p.score)
        return {
            "type": "state",
            "phase": self.phase,
            "minPlayers": MIN_PLAYERS,
            "remaining": max(0, int(self.ends_at - time.time())) if self.phase == "running" else 0,
            "players": [p.public() for p in ranked],
        }

    async def broadcast(self):
        msg = self.snapshot()
        targets = list(self.boards) + [p.ws for p in self.players.values() if p.ws]
        for ws in targets:
            try:
                await ws.send_json(msg)
            except Exception:
                pass

    # ---- player events ----

    def join(self, name, ws):
        name = name.strip()[:20]
        if not name:
            return None, "Enter a name"
        p = self.players.get(name)
        if p is None:
            if self.phase != "lobby":
                return None, "Game already started. Wait for the next round."
            p = self.players[name] = Player(name)
        p.ws = ws
        return p, None

    def pickup(self, p):
        if not p.down:
            return
        p.down = False
        p.up_since = time.time()
        if self.phase != "running" or p.roasting:
            return
        p.pickups += 1
        p.score -= PICKUP_PENALTY
        self.start_roast(p, roasts.PICKUP)

    def putdown(self, p):
        p.down = True

    def shake(self, p):
        if not p.roasting:
            return
        p.roasting = False
        p.up_since = time.time()  # nag timer restarts after a shake
        self.speaker.cancel(p.name)
        self.speaker.say(roasts.line(roasts.SURRENDER, name=p.name), tag=p.name)

    def start_roast(self, p, lines):
        p.roasting = True
        p.next_roast_at = time.time() + ROAST_REPEAT_SECONDS
        self.speaker.say(roasts.line(lines, name=p.name), tag=p.name)

    # ---- board events ----

    def start(self, minutes):
        ready = [p for p in self.players.values() if p.ready and p.ws]
        if len(ready) < MIN_PLAYERS:
            return f"Need at least {MIN_PLAYERS} ready players"
        for p in self.players.values():
            p.score, p.pickups, p.roasting = 0, 0, False
        self.phase = "running"
        self.ends_at = time.time() + max(1, minutes) * 60
        self.leader = None
        self.last_lead_announce = time.time()  # no lead callouts in the first few seconds
        self.speaker.say(roasts.line(roasts.START, count=len(ready)))
        return None

    def reset(self):
        self.phase = "lobby"
        for p in self.players.values():
            p.score, p.pickups, p.roasting = 0, 0, False
        # drop players who left so the lobby is clean
        self.players = {n: p for n, p in self.players.items() if p.ws}

    def finish(self):
        self.phase = "ended"
        for p in self.players.values():
            p.roasting = False
        ranked = sorted(self.players.values(), key=lambda p: -p.score)
        if not ranked:
            return
        win, lose = ranked[0], ranked[-1]
        self.speaker.say(roasts.line(roasts.WIN, name=win.name, score=win.score))
        if lose is not win and lose.pickups > 0:
            self.speaker.say(roasts.line(roasts.LOSER, name=lose.name, pickups=lose.pickups))
        for p in ranked:
            if p.pickups == 0:
                self.speaker.say(roasts.line(roasts.PERFECT, name=p.name))
                break

    # ---- once a second ----

    def tick(self):
        if self.phase != "running":
            return
        now = time.time()
        if now >= self.ends_at:
            self.finish()
            return
        for p in self.players.values():
            if p.down and not p.roasting:
                p.score += 1
            if not p.ws:
                p.roasting = False  # they left; one roast is enough, don't loop forever
                continue
            if p.roasting and now >= p.next_roast_at:
                p.score -= ROAST_PENALTY
                p.next_roast_at = now + ROAST_REPEAT_SECONDS
                self.speaker.say(roasts.line(roasts.REPEAT, name=p.name), tag=p.name)
            elif not p.down and not p.roasting and now - p.up_since > NAG_SECONDS:
                p.score -= ROAST_PENALTY
                self.start_roast(p, roasts.NAG)

        top = max(self.players.values(), key=lambda p: p.score, default=None)
        if top and top.name != self.leader:
            prev = self.players.get(self.leader)
            if prev is None or top.score > prev.score:  # strict, so ties don't flip-flop
                if prev is not None and now - self.last_lead_announce > LEAD_ANNOUNCE_GAP:
                    self.speaker.say(roasts.line(roasts.LEAD, name=top.name))
                    self.last_lead_announce = now
                self.leader = top.name


speaker = None
game = None


async def ticker():
    while True:
        await asyncio.sleep(1)
        game.tick()
        await game.broadcast()


@asynccontextmanager
async def lifespan(app):
    global speaker, game
    speaker = Speaker()
    game = Game(speaker)
    tasks = [asyncio.create_task(speaker.run()), asyncio.create_task(ticker())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def phone_page():
    return FileResponse(STATIC / "phone.html")


@app.get("/board")
async def board_page():
    return FileResponse(STATIC / "board.html")


@app.websocket("/ws")
async def phone_socket(ws: WebSocket):
    await ws.accept()
    player = None
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if kind == "join":
                player, err = game.join(str(msg.get("name", "")), ws)
                await ws.send_json({"type": "joined", "name": player.name} if player else {"type": "error", "message": err})
            elif player is None:
                continue
            elif kind == "ready":
                player.ready = True
                player.down = bool(msg.get("down"))
            elif kind == "pickup":
                game.pickup(player)
            elif kind == "putdown":
                game.putdown(player)
            elif kind == "shake":
                game.shake(player)
            await game.broadcast()
    except WebSocketDisconnect:
        pass
    finally:
        if player and player.ws is ws:
            player.ws = None
            game.pickup(player)  # closing the page or locking the phone counts as picking it up
            if game.phase == "lobby":
                game.players.pop(player.name, None)
            await game.broadcast()


@app.websocket("/ws/board")
async def board_socket(ws: WebSocket):
    await ws.accept()
    game.boards.add(ws)
    await ws.send_json(game.snapshot())
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "start":
                err = game.start(int(msg.get("minutes", 25)))
                if err:
                    await ws.send_json({"type": "error", "message": err})
            elif msg.get("type") == "reset":
                game.reset()
            elif msg.get("type") == "test-voice":
                speaker.say("Buzzkill speaker check. If you can hear this, put your phones down.")
            await game.broadcast()
    except WebSocketDisconnect:
        pass
    finally:
        game.boards.discard(ws)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    print(f"\nBuzzkill running. Phones: http://<pi-ip>:{port}/   Board: http://<pi-ip>:{port}/board")
    print("For iPhones you need HTTPS, see README (cloudflared).\n")
    uvicorn.run(app, host="0.0.0.0", port=port)
