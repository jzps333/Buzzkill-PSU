"""The Buzzkill brick: NFC tag + touch sensor. (Roasts on the speaker are speaker.py's job.)

On boot the tag points to the website. With SUPABASE_SERVICE_KEY in .env the touch sensor runs games:
  tap (no game)   -> create a game, send its roasts to this Pi's speaker, tag opens the join link
  tap (waiting)   -> start the game (needs 4+ players)
  hold 3 seconds  -> end the game, tag goes back to the website
"""
import os
import subprocess
import threading
import time
from pathlib import Path

import requests
from gpiozero import Button

import nfc

HERE = Path(__file__).resolve().parent
for line in (HERE / ".env").read_text().splitlines() if (HERE / ".env").exists() else []:
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

SITE = os.environ.get("SITE_URL", "https://buzzkill-psu.vercel.app").rstrip("/")
SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SPEAKER_ID = os.environ.get("SPEAKER_ID", "brick")
TOUCH_PIN = int(os.environ.get("TOUCH_PIN", "5"))   # Grove port D5 = GPIO 5
ONLINE = SB_KEY.startswith("sb_secret")
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

code = None          # current room code
lock = threading.Lock()


def say(text):
    # Short status lines only. While a game is live, speaker.py does the talking.
    subprocess.Popen(["espeak-ng", "-v", "en-us", "-s", "160", "-a", "200", text])


def rpc(name, args=None):
    r = requests.post(f"{SB_URL}/rest/v1/rpc/{name}", json=args or {}, headers=HEADERS, timeout=10)
    if r.status_code >= 300:
        raise RuntimeError(r.json().get("message", r.text))
    return r.json() if r.text else None


def game_status():
    r = requests.get(f"{SB_URL}/rest/v1/games", params={"code": f"eq.{code}", "select": "status"},
                     headers=HEADERS, timeout=10)
    r.raise_for_status()
    rows = r.json()
    return rows[0]["status"] if rows else None


def on_tap():
    global code
    if not ONLINE:
        say("Buzzkill is ready. Tap your phone on the brick.")
        return
    with lock:
        try:
            if code is None:
                code = rpc("create_game")
                try:
                    rpc("set_game_speaker", {"p_code": code, "p_speaker": SPEAKER_ID})
                except Exception as e:
                    print("speaker not set (is speaker.py running?):", e)
                nfc.write_url(f"{SITE}/join?room={code}")
                print("game", code)
                say("New game. Tap your phones on the brick to join.")
            elif game_status() == "waiting":
                rpc("start_game", {"p_code": code})
                say("Game on. Phones down. Good luck.")
        except Exception as e:
            print("tap failed:", e)
            say("Need at least 4 players." if "4 players" in str(e) else "Something went wrong.")


def on_hold():
    if not ONLINE or code is None:
        return
    with lock:
        try:
            if game_status() == "live":
                rpc("finish_game", {"p_code": code})
            else:
                rpc("cancel_game", {"p_code": code})
        except Exception as e:
            print("end failed:", e)
        reset()
    say("Game over. Check your phones for results.")


def reset():
    global code
    code = None
    nfc.write_url(SITE + "/")


def watch_game():
    # If the game is ended from the website, point the tag back at the home page.
    # While waiting, clear out players who left the lobby.
    while True:
        time.sleep(3)
        if code is None:
            continue
        try:
            status = game_status()
            if status in (None, "ended", "cancelled"):
                with lock:
                    reset()
            elif status == "waiting":
                rpc("prune_lobby", {"p_code": code})     # drop players who closed their browser
        except Exception as e:
            print("check failed:", e)


if __name__ == "__main__":
    nfc.write_url(SITE + "/")
    print("Tag ready:", nfc.read_url(), "| online mode:", ONLINE)

    touch = Button(TOUCH_PIN, pull_up=None, active_state=True, hold_time=3)
    held = [False]
    touch.when_pressed = lambda: held.__setitem__(0, False)
    touch.when_held = lambda: (held.__setitem__(0, True), on_hold())
    touch.when_released = lambda: None if held[0] else on_tap()   # tap = let go before 3 s
    if ONLINE:
        watch_game()
    else:
        threading.Event().wait()
