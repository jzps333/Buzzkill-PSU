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


# ---------- AI roasts: one per pickup ----------
# In teams, a pickup busts the whole team, and they all share the roast of whoever slipped (alarm_cause).
recent = []      # last few roast lines, sent along so the next roast is different
roasts = {}      # bust key -> "loading" | {"mp3": path, "text": ...} | {"text": ...} | {} (failed: built-in roast)


def culprit(p):
    return p.get("alarm_cause") or p["user_id"]


def bust_key(p, players):
    who = next((x for x in players if x["user_id"] == culprit(p)), p)
    return f"{culprit(p)}:{who['pickups']}"


def fetch_roast(key, code, user_id):
    try:
        r = requests.post(f"{BASE}/functions/v1/roast", headers=HEADERS,
                          json={"game": code, "user_id": user_id, "avoid": recent[-6:]}, timeout=15)
        r.raise_for_status()
        text = unquote(r.headers.get("X-Roast-Text", ""))
        if r.headers.get("content-type", "").startswith("audio"):
            path = ROAST_DIR / (key.replace(":", "-") + ".mp3")
            path.write_bytes(r.content)
            roasts[key] = {"mp3": str(path), "text": text}
        else:
            roasts[key] = {"text": r.json().get("text")}      # no voice credits left: espeak reads it
        if roasts[key].get("text"):
            recent.append(roasts[key]["text"])
        log("AI roast:", roasts[key].get("text"))
    except Exception as e:
        log("AI roast failed, using a built-in one:", e)
        roasts[key] = {}


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
    if key in roasts:
        return
    if not AI_ROASTS:
        roasts[key] = {}
        return
    roasts[key] = "loading"
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

            players = get("results", game=f"eq.{code}",
                          select="user_id,pickups,alarm_on,alarm_cause,is_shaking,last_shake_at,profiles(username)")

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
            else:
                for p in loud:           # one AI roast per new pickup, fetched in the background
                    ask_for_roast(bust_key(p, players), code, culprit(p))
                if not voice.busy():
                    p = random.choice(loud)
                    r = roasts.get(bust_key(p, players))
                    if r != "loading":   # AI roast on its way (a second or two)
                        name = (p.get("profiles") or {}).get("username") or "Someone"
                        text = (r or {}).get("text") or random.choice(ROASTS).format(n=name)
                        if r and r.get("mp3"):
                            voice.play(r["mp3"], text, p["user_id"])
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
