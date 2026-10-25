#!/usr/bin/env python3
"""
Buzzkill speaker: plays the roasts out loud on the Pi's Bluetooth speaker.

  python3 speaker.py           run it (Ctrl+C to stop)
  python3 speaker.py --test    say one roast and quit (checks the speaker works)

What it does, about twice a second:
  1. Finds the open game whose host picked this speaker (games.speaker = SPEAKER_ID).
  2. Reads that game's players from `results`.
  3. Plays a roast on loop while anyone has alarm_on and is NOT shaking. Otherwise silent.
     Each new pickup gets one AI roast (the "roast" Supabase function: Gemini writes it, ElevenLabs says it).
     No AI voice? It reads the text with espeak-ng, or one of the built-in roasts.
Every 5 seconds it checks in (speakers.last_seen) so the host page shows "Speaker online".

Settings come from hardware/.env (see .env.example). Needs `requests`, `espeak-ng` and `mpg123`.
"""
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

import requests

ROASTS = [
    '{n}, the textbook just asked where you went.',
    'And {n} fumbles the focus! The crowd goes quiet.',
    "{n}. I'm not mad. I'm just a little disappointed.",
    'Breaking news: phone one, {n} zero.',
    'Here we see the wild {n}, unable to resist the glowing rectangle.',
    'Survey says: {n} picked up the phone. Uh oh.',
    'Ooooh, {n}. Whatever it was, it could have waited.',
    '{n}, your notes are feeling very ignored right now.',
    'Ding ding ding! {n} is our first contestant to crack.',
    'Hold on, {n}. Is the phone studying for you?',
    'Tsk tsk, {n}. So close to a clean game.',
    '{n} has left the study session. Physically still here, though.',
    "This just in: {n}'s focus has been reported missing.",
    'Yikes, {n}. Everyone saw that.',
    '{n}, put it down and nobody has to talk about this.',
    'Wow, {n}. Bold move picking it up right in front of the bee.',
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
BASE = os.environ["SUPABASE_URL"].rstrip("/")
URL = BASE + "/rest/v1"
KEY = os.environ["SUPABASE_SERVICE_KEY"]
SPEAKER_ID = os.environ.get("SPEAKER_ID", "brick")
SPEAKER_NAME = os.environ.get("SPEAKER_NAME", "Buzzkill speaker")
BT_MAC = os.environ.get("BT_SPEAKER_MAC", "").strip()
TTS_CMD = os.environ.get("TTS_CMD", "espeak-ng -v en-us -s 160 -a 200").split()
PLAY_CMD = os.environ.get("PLAY_CMD", "mpg123 -q").split()
AI_ROASTS = os.environ.get("AI_ROASTS", "1") != "0"

HEADERS = {"apikey": KEY, "Content-Type": "application/json"}
http = requests.Session()
http.headers.update(HEADERS)
ROAST_DIR = Path(tempfile.mkdtemp(prefix="buzzkill-roasts-"))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------- Supabase (plain REST, no SDK needed) ----------
def get(table, **params):
    r = http.get(f"{URL}/{table}", params=params, timeout=5)
    r.raise_for_status()
    return r.json()


_heartbeat_ok = True


def heartbeat():
    # Lets the website's host page show "Buzzkill speaker online". If it fails, roasts still work.
    global _heartbeat_ok
    try:
        _heartbeat()
        _heartbeat_ok = True
    except requests.RequestException as e:
        if _heartbeat_ok:
            log("Check-in failed (the host page will show the speaker offline; run backend/speaker.sql):", e)
        _heartbeat_ok = False


def _heartbeat():
    r = http.post(f"{URL}/speakers",
                  headers={"Prefer": "resolution=merge-duplicates"},
                  json={"id": SPEAKER_ID, "name": SPEAKER_NAME,
                        "last_seen": datetime.now(timezone.utc).isoformat()},
                  timeout=5)
    r.raise_for_status()


GAME_FILE = Path(__file__).with_name(".game")    # brick.py writes the code of the game it's running here


def current_game():
    """The open game that picked this speaker (a live one wins over one still waiting).
    If the database can't say (no games.speaker column), the game the brick on this Pi is running."""
    try:
        games = get("games", select="*", speaker=f"eq.{SPEAKER_ID}", status="in.(waiting,live)")
        games.sort(key=lambda g: g["status"] != "live")
        if games:
            return games[0]
    except requests.RequestException:
        pass
    try:
        code = GAME_FILE.read_text().strip()
    except OSError:
        return None
    if not code:
        return None
    rows = get("games", select="*", code=f"eq.{code}")
    return rows[0] if rows and rows[0]["status"] in ("waiting", "live") else None


# ---------- AI roasts: a brand-new line every time ----------
# Each pickup gets a queue of fresh lines. While one plays, the next is already being written.
# In teams, a pickup busts the whole team, and they all share the lines for whoever slipped (alarm_cause).
recent = []      # lines already said this game, sent along so the next one is different
roasts = {}      # bust key -> {"queue": [{"mp3": path, "text": ...} or {"text": ...}], "loading": bool, "heard": n, "failed": bool}
line_no = 0


def culprit(p):
    return p.get("alarm_cause") or p["user_id"]


def bust_key(p, players):
    who = next((x for x in players if x["user_id"] == culprit(p)), p)
    return f"{culprit(p)}:{who['pickups']}"


def fetch_roast(key, code, user_id):
    global line_no
    b = roasts[key]
    try:
        r = requests.post(f"{BASE}/functions/v1/roast", headers=HEADERS,
                          json={"game": code, "user_id": user_id, "avoid": recent[-10:], "again": b["heard"]}, timeout=15)
        r.raise_for_status()
        text = unquote(r.headers.get("X-Roast-Text", ""))
        if r.headers.get("content-type", "").startswith("audio"):
            line_no += 1
            path = ROAST_DIR / f"{key.replace(':', '-')}-{line_no}.mp3"
            path.write_bytes(r.content)
            line = {"mp3": str(path), "text": text}
        else:
            line = {"text": r.json().get("text")}             # no voice credits left: espeak reads it
        if line.get("text"):
            recent.append(line["text"])
        b["queue"].append(line)
        log("AI roast:", line.get("text"))
    except Exception as e:
        log("AI roast failed, using built-in ones for this pickup:", e)
        b["failed"] = True
    finally:
        b["loading"] = False


def ai_voice(text):
    """Any short line in the ElevenLabs roast voice (startup, test). Returns an mp3 path, or None."""
    if not AI_ROASTS:
        return None
    try:
        r = requests.post(f"{BASE}/functions/v1/roast", headers=HEADERS, json={"say": text}, timeout=15)
        if r.ok and r.headers.get("content-type", "").startswith("audio"):
            path = ROAST_DIR / f"line-{abs(hash(text))}.mp3"
            path.write_bytes(r.content)
            return str(path)
    except requests.RequestException as e:
        log("AI voice failed, using espeak:", e)
    return None


def ask_for_roast(key, code, user_id):
    """Keep one fresh line ready (or on its way) for this pickup."""
    b = roasts.setdefault(key, {"queue": [], "loading": False, "heard": 0, "failed": not AI_ROASTS})
    if b["loading"] or b["queue"] or b["failed"]:
        return
    b["loading"] = True
    threading.Thread(target=fetch_roast, args=(key, code, user_id), daemon=True).start()


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

    def _run(self, cmd, who):
        self.stop()
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.who = who

    def say(self, text, who=None):
        log("Saying:", text)
        self._run(TTS_CMD + [text], who)

    def line(self, text):
        """Say one of the speaker's own lines in the AI voice (espeak if that's not available), and wait."""
        mp3 = ai_voice(text)
        text = re.sub(r"\s*\[[^\]]*\]\s*", " ", text).strip()     # [tags] are for the AI voice only
        if mp3:
            self.play(mp3, text)
        else:
            self.say(text)
        self.proc.wait()

    def play(self, mp3, text, who=None):
        try:
            self._run(PLAY_CMD + [mp3], who)
        except FileNotFoundError:
            log(f"'{PLAY_CMD[0]}' isn't installed (sudo apt install mpg123), reading the text instead")
            self.say(text, who)

    def stop(self):
        if self.busy():
            self.proc.kill()
            self.proc.wait()
        self.proc = None
        self.who = None


def main():
    voice = Voice()

    if "--test" in sys.argv:
        voice.line(ROASTS[0].format(n="Test"))
        return

    if BT_MAC:
        threading.Thread(target=bluetooth_loop, daemon=True).start()

    log(f"Speaker '{SPEAKER_ID}' running. Pick it on the host page to use it.")
    voice.line("[mischievously] Buzzkill speaker ready. Phones down, everyone.")

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
                roasts.clear()
                log("Game", code, "is live")

            players = get("results", game=f"eq.{code}", select="*,profiles(username)")    # "*": never fails on a missing column

            # Sound plays when your alarm is on and you're NOT shaking.
            # Still "shaking" but no new shake for 2s (phone died, lost signal) = stopped.
            loud = []
            for p in players:
                uid = p["user_id"]
                if shake_seen.get(uid, (None,))[0] != p.get("last_shake_at"):
                    shake_seen[uid] = (p.get("last_shake_at"), now)
                shaking_now = p.get("is_shaking") and now - shake_seen[uid][1] < SHAKE_TIMEOUT
                if p["alarm_on"] and not shaking_now:
                    loud.append(p)

            loud_ids = {p["user_id"] for p in loud}
            if voice.who and voice.who not in loud_ids:
                voice.stop()             # they started shaking: cut the roast off right away
            if not loud:
                voice.stop()
            else:
                for p in loud:           # keep a fresh line ready for everyone who's busted
                    ask_for_roast(bust_key(p, players), code, culprit(p))
                if not voice.busy():
                    p = random.choice(loud)
                    key = bust_key(p, players)
                    b = roasts.get(key)
                    if b and (b["queue"] or b["failed"]):    # otherwise the next line is still being written
                        line = b["queue"].pop(0) if b["queue"] else {}
                        b["heard"] += 1
                        ask_for_roast(key, code, culprit(p))     # start writing the one after this, right now
                        name = (p.get("profiles") or {}).get("username") or "Someone"
                        text = line.get("text") or random.choice(ROASTS).format(n=name)
                        if line.get("mp3"):
                            voice.play(line["mp3"], text, p["user_id"])
                        else:
                            voice.say(text, p["user_id"])

        except requests.RequestException as e:
            log("Network problem:", e)
            time.sleep(2)

        time.sleep(POLL_SECS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
