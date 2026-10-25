"""The Buzzkill brick: NFC tag + touch sensor + JBL speaker.

On boot the tag points to the website. With SUPABASE_SERVICE_KEY in .env it also runs games:
  tap (no game)   -> create a game, tag now opens the join link for that room
  tap (waiting)   -> start the game (needs 4+ players)
  hold 3 seconds  -> end the game, tag goes back to the website
While a game is live, roasts play on loop for anyone whose alarm is on and who isn't shaking.
"""
import os
import random
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
        os.environ.setdefault(k.strip(), v.strip())

SITE = os.environ.get("SITE_URL", "https://buzzkill-psu.vercel.app").rstrip("/")
SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SPEAKER = os.environ.get("SPEAKER_MAC", "")
TOUCH_PIN = int(os.environ.get("TOUCH_PIN", "5"))   # Grove port D5 = GPIO 5
ONLINE = SB_KEY.startswith("sb_secret")

ROASTS = [
    "{} picked up their phone. Your future self is disappointed.",
    "Attention everyone. {} could not last. Shake it off, {}.",
    "{} is doomscrolling again. Put it down.",
    "Wow {}. That notification was not important.",
]

code = None          # current room code
status = None        # waiting / live / ended
voice = None         # the espeak process that's talking right now
last_shake = {}      # user_id -> (shake_secs_done, when it last went up)
lock = threading.Lock()


# ---------- speaker ----------
def say(text, wait=False):
    global voice
    hush()
    voice = subprocess.Popen(["espeak-ng", "-s", "150", "-a", "200", text])
    if wait:
        voice.wait()


def hush():
    if voice and voice.poll() is None:
        voice.kill()


def talking():
    return voice is not None and voice.poll() is None


def keep_speaker_connected():
    while SPEAKER:
        info = subprocess.run(["bluetoothctl", "info", SPEAKER], capture_output=True, text=True).stdout
        if "Connected: yes" not in info:
            subprocess.run(["bluetoothctl", "connect", SPEAKER], capture_output=True)
        time.sleep(15)


# ---------- Supabase (plain REST, secret key = acts as the Pi) ----------
def rpc(name, args=None):
    r = requests.post(f"{SB_URL}/rest/v1/rpc/{name}", json=args or {}, timeout=10,
                      headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"})
    if r.status_code >= 300:
        raise RuntimeError(r.json().get("message", r.text))
    return r.json() if r.text else None


def get(table, query):
    r = requests.get(f"{SB_URL}/rest/v1/{table}?{query}", timeout=10,
                     headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"})
    r.raise_for_status()
    return r.json()


# ---------- touch sensor ----------
def on_tap():
    global code, status
    if not ONLINE:
        say("Buzzkill is ready. Tap your phone on the brick.")
        return
    with lock:
        try:
            if code is None:
                code, status = rpc("create_game"), "waiting"
                nfc.write_url(f"{SITE}/join?room={code}")
                say("New game. Tap your phones on the brick to join.")
            elif status == "waiting":
                rpc("start_game", {"p_code": code})
                status = "live"
                say("Game on. Phones down. Good luck.")
        except Exception as e:
            print("tap failed:", e)
            say("Need at least 4 players." if "4 players" in str(e) else "Something went wrong.")


def on_hold():
    global code, status
    if not ONLINE or code is None:
        return
    with lock:
        try:
            rpc("finish_game", {"p_code": code})
        except Exception as e:
            print("finish failed:", e)
        reset()
    say("Game over. Check your phones for results.")


def reset():
    global code, status
    code, status = None, None
    last_shake.clear()
    hush()
    nfc.write_url(SITE + "/")


# ---------- roast loop ----------
def loud_players():
    rows = get("results", f"game=eq.{code}&select=user_id,alarm_on,is_shaking,shake_secs_done,profiles(username)")
    now, loud = time.time(), []
    for p in rows:
        done = p["shake_secs_done"]
        prev = last_shake.get(p["user_id"])
        if prev is None or done != prev[0]:
            last_shake[p["user_id"]] = (done, now)
        # Shaking only counts if their shake time went up in the last 2 s (phone died = sound back on)
        shaking = p["is_shaking"] and now - last_shake[p["user_id"]][1] < 2
        if p["alarm_on"] and not shaking:
            loud.append((p.get("profiles") or {}).get("username") or "Someone")
    return loud


def game_loop():
    global status
    checked = 0
    while True:
        time.sleep(0.5)
        if code is None:
            continue
        try:
            if time.time() - checked > 3:       # notice if the game was ended from the website
                checked = time.time()
                g = get("games", f"code=eq.{code}&select=status")
                if not g or g[0]["status"] == "ended":
                    with lock:
                        reset()
                    continue
                status = g[0]["status"]
            if status != "live":
                continue
            loud = loud_players()
            if not loud:
                hush()
            elif not talking():
                say(random.choice(ROASTS).replace("{}", random.choice(loud)))
        except Exception as e:
            print("poll failed:", e)


if __name__ == "__main__":
    threading.Thread(target=keep_speaker_connected, daemon=True).start()
    nfc.write_url(SITE + "/")
    print("Tag ready:", nfc.read_url(), "| online mode:", ONLINE)

    touch = Button(TOUCH_PIN, pull_up=None, active_state=True, hold_time=3)
    held = [False]
    touch.when_pressed = lambda: held.__setitem__(0, False)
    touch.when_held = lambda: (held.__setitem__(0, True), on_hold())
    touch.when_released = lambda: None if held[0] else on_tap()   # tap = let go before 3 s
    time.sleep(3)    # give Bluetooth a moment
    say("Buzzkill is ready.")
    game_loop()
