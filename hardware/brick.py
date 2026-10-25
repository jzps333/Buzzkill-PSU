"""The Buzzkill brick: a touch sensor and a speaker. Roasts are speaker.py's job; this is the game host.

Touch sensor (the speaker answers every tap):
  tap         no game -> new SOLO game (right after a game ends too: one tap = the next game)
              waiting -> says the PIN again (slowly, twice) and how many people are in, every tap until the game starts
              live    -> says the time left and the scoreboard
  double tap  no game -> new TEAMS game
              waiting -> start the game now (4+ players)
  triple tap  end the game and say who won (or close it if it never started)
  hold 3 s    same as triple tap
  (no tap)    the game starts by itself 5 seconds after the 4th player joins (AUTO_START in .env)

The brick follows any open game that uses this speaker, so games started from /host show up too.
The NFC sticker / QR code on the brick points at /brick, which always forwards to this game.

  python3 brick.py            run it (the buzzkill service does this on boot)
  python3 brick.py --status   what the brick sees right now: run it while people are joining
"""
import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
for line in (HERE / ".env").read_text().splitlines() if (HERE / ".env").exists() else []:
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SPEAKER_ID = os.environ.get("SPEAKER_ID", "brick")
TOUCH_PIN = int(os.environ.get("TOUCH_PIN", "5"))     # Grove port D5 = GPIO 5
AUTO_START = int(os.environ.get("AUTO_START", "4"))   # start by itself once this many have joined (0 = only by double tap)
ONLINE = SB_KEY.startswith("sb_secret")
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

code = None          # current room code
game = {}            # its games row
players = []         # its results rows
auto_for = None      # the game a start countdown is running for
auto_tried = 0       # when the last auto-start was tried (a failed one retries, but not every second)
last_count = None    # (game, players) last written to the log
lock = threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------- the voice ----------
voice = None
said = 0                 # counts announcements, so a newer tap wins over an older one still loading
AI_VOICE = os.environ.get("AI_ROASTS", "1") != "0"
VOICE_DIR = Path(tempfile.mkdtemp(prefix="buzzkill-brick-"))
voiced = {}              # text -> mp3 path, so repeated lines ("Game on") don't cost credits again


def short(text, limit=200):
    # The voice function reads at most 200 characters: cut at the last full sentence that fits
    if len(text) <= limit:
        return text
    cut = text[:limit]
    return cut[:cut.rfind(". ") + 1] or cut


def eleven(text):
    """The line in the ElevenLabs roast voice (the same "roast" Supabase function speaker.py uses). mp3 path or None."""
    if not (ONLINE and AI_VOICE):
        return None
    if text not in voiced:
        try:
            r = requests.post(f"{SB_URL}/functions/v1/roast", json={"say": text}, timeout=15,
                              headers={**HEADERS, "Content-Type": "application/json"})
            if not (r.ok and r.headers.get("content-type", "").startswith("audio")):
                print("ElevenLabs voice not available, using espeak:", r.status_code, r.text[:120])
                return None
            path = VOICE_DIR / f"line-{len(voiced)}.mp3"
            path.write_bytes(r.content)
            voiced[text] = str(path)
        except requests.RequestException as e:
            print("ElevenLabs voice failed, using espeak:", e)
            return None
    return voiced[text]


def say(text):
    # The brick's own announcements (PIN, scoreboard, time). Roasts are speaker.py's job.
    global said
    said += 1
    log("say:", text)
    threading.Thread(target=_say, args=(short(text), said), daemon=True).start()


def _say(text, n):
    global voice
    mp3 = eleven(text)                  # takes a second or two
    if n != said:
        return                          # someone tapped again meanwhile: only the newest line plays
    if voice and voice.poll() is None:
        voice.kill()                    # cut off the last announcement
    speed = "120" if "PIN" in text else "150"         # the robot voice reads PINs slower too
    cmd = ["mpg123", "-q", mp3] if mp3 else ["espeak-ng", "-v", "en-us", "-s", speed, "-g", "6", "-a", "200", text]
    voice = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)



# ---------- Supabase (plain REST, secret key = acts as the Pi) ----------
class DbError(RuntimeError):
    pass


def _check(r):
    if r.status_code >= 300:
        try:
            msg = r.json().get("message") or r.text
        except ValueError:
            msg = r.text
        raise DbError(f"{r.status_code}: {msg[:200]}")


def rpc(name, args=None):
    r = requests.post(f"{SB_URL}/rest/v1/rpc/{name}", json=args or {}, headers=HEADERS, timeout=10)
    _check(r)
    return r.json() if r.text else None


def get(table, **params):
    r = requests.get(f"{SB_URL}/rest/v1/{table}", params=params, headers=HEADERS, timeout=10)
    _check(r)
    return r.json()


# ---------- game actions ----------
def new_game(mode):
    global code
    with lock:
        try:
            code = rpc("create_game", {"p_mode": mode})
            try:
                rpc("set_game_speaker", {"p_code": code, "p_speaker": SPEAKER_ID})
            except Exception as e:
                log("speaker not linked (roasts won't play on the brick; run backend/speaker.sql):", e)
            log("new", mode, "game", code)
            say(("New team game. " if mode == "teams" else "New game. ") + pin_line())
        except Exception as e:
            log("create failed:", e)
            say("Couldn't start a game. Check the brick's internet.")


def start():
    if game.get("status") != "waiting":
        return
    with lock:
        try:
            rpc("start_game", {"p_code": code})
            game["status"] = "live"
            log("game", code, "started")
            say("Game on. Phones down. Good luck.")
        except Exception as e:
            log("start failed:", e)
            if "4 players" in str(e):
                say("Couldn't start yet. Need at least 4 players, and everyone has to keep the page open.")
            elif "even" in str(e).lower():
                say("Teams need an even number of players.")
            else:
                say("Couldn't start the game. Check the brick's log.")


def end_game():
    """Triple tap or hold: end a live game (and say who won), or close one that never started."""
    if not ONLINE:
        return on_tap()
    if code is None:
        return say("No game running. Tap to start one.")
    with lock:
        live = game.get("status") == "live"
        final = list(players)
        try:
            rpc("finish_game" if live else "cancel_game", {"p_code": code})
        except Exception as e:
            log("end failed:", e)
        reset()
    if live:
        say(f"Game over. {winner_line(final)} Tap to start a new game.")
    else:
        say("Game closed. Tap to start a new game.")


def reset():
    global code, game, players
    code, game, players = None, {}, []


# ---------- touch sensor ----------
def on_tap():
    if not ONLINE:
        return say("Buzzkill is ready, but not connected to the game yet. Add the secret key.")
    if code is None:
        return new_game("solo")
    if game.get("status") == "waiting":
        say(lobby_line())
    elif game.get("status") == "live":
        say(time_line() + " " + score_line())


def on_double():
    if not ONLINE:
        return on_tap()
    if code is None:
        new_game("teams")
    elif game.get("status") == "waiting":
        start()
    else:
        on_tap()


# ---------- keep up with the game ----------
def refresh():
    """Find the brick's game and read it, then auto-start it when enough players are in."""
    global code, game, players
    if code is None:
        found = get("games", select="*", speaker=f"eq.{SPEAKER_ID}", status="in.(waiting,live)")
        if not found:
            return
        code = found[0]["code"]                      # e.g. a game started from /host
    rows = get("games", select="*", code=f"eq.{code}")    # "*": never fails on a column that isn't there
    g = rows[0] if rows else None
    if not g or g.get("status") in ("ended", "cancelled") or g.get("speaker", SPEAKER_ID) not in (SPEAKER_ID, None):
        with lock:
            reset()
        return
    game = g
    players = get("results", select="user_id,pickups,alarm_on,profiles(username)", game=f"eq.{code}")
    auto_start()


def auto_start():
    """Enough players joined: count down 5 seconds, then start (same as a double tap)."""
    global auto_for, auto_tried, last_count
    if game.get("status") == "waiting" and (code, len(players)) != last_count:
        last_count = (code, len(players))
        log(f"lobby {code}: {len(players)} player(s) in (auto-start at {AUTO_START or 'off'})")
    if not AUTO_START or game.get("status") != "waiting" or len(players) < AUTO_START:
        return
    if auto_for == code or time.time() - auto_tried < 12:      # countdown running, or just tried
        return
    auto_for, auto_tried = code, time.time()
    log(f"auto-start: {len(players)} players in {code}, starting in 5 s")
    say(f"{len(players)} players in. Starting in 5 seconds. Phones face down.")

    def go(c=code):
        global auto_for
        if code == c and game.get("status") == "waiting":
            start()
        auto_for = None              # if it didn't start (someone left), try again once 4+ are in
    threading.Timer(5, go).start()


def name(p):
    return (p.get("profiles") or {}).get("username") or "player"


def timer():
    """(on_break, seconds left in this focus/break, seconds since start). No pomodoro: seconds left = None."""
    start = datetime.fromisoformat(game["start_time"]) if game.get("start_time") else datetime.now(timezone.utc)
    t = (datetime.now(timezone.utc) - start).total_seconds()
    w, b = (game.get("pomo_work") or 0) * 60, (game.get("pomo_break") or 0) * 60
    if not (w and b):
        return False, None, t
    pos = t % (w + b)
    return pos >= w, (w + b - pos) if pos >= w else (w - pos), t


# ---------- what the brick says when tapped ----------
def minutes(secs):
    m = round(secs / 60)
    return "less than a minute" if secs < 60 else f"{m} minute{'s' if m != 1 else ''}"


def names(ps):
    ns = [name(p) for p in ps]
    return ns[0] if len(ns) == 1 else ", ".join(ns[:-1]) + " and " + ns[-1]


def slow(pin):
    return " ".join(ch + "." for ch in pin)                   # "4. F. 2. A. 9. C.": a pause after every character


def pin_line():
    # Slowly, and twice, so people can type it in
    return f"Your PIN is: {slow(code)} Again: {slow(code)}"


def lobby_line():
    n = len(players)
    who = f"{n} player{'s' if n != 1 else ''} in" + (f": {names(players)}." if players else ".")
    if n < 4:
        return f"{pin_line()} {who} Need {4 - n} more to start."
    return f"{pin_line()} {who} " + ("Starting now." if AUTO_START and n >= AUTO_START else "Double tap to start.")


def time_line():
    on_break, left, t = timer()
    if left is None:
        return f"{minutes(t)} in."
    if on_break:
        return f"Break time. {minutes(left)} left."
    return f"Focus time. {minutes(left)} left, then a {game['pomo_break']} minute break."


def score_line():
    if not players:
        return ""
    if all(p["pickups"] == 0 for p in players):
        return "Nobody has touched their phone. Legends."
    worst = max(players, key=lambda p: p["pickups"])
    n = worst["pickups"]
    line = f"{name(worst)} is losing, with {n} pickup{'s' if n != 1 else ''}"
    line += "."
    clean = [p for p in players if p["pickups"] == 0]
    if clean:
        line += f" {names(clean)} {'is' if len(clean) == 1 else 'are'} still clean."
    else:
        best = min(players, key=lambda p: p["pickups"])
        line += f" {name(best)} is winning, with {best['pickups']}."
    return line


def winner_line(final):
    if not final:
        return ""
    fewest = min(p["pickups"] for p in final)
    best = [p for p in final if p["pickups"] == fewest]
    n = "zero" if fewest == 0 else str(fewest)
    picks = "pickup" if fewest == 1 else "pickups"
    if len(best) == len(final):
        return f"Everyone tied with {n} {picks}."
    if len(best) == 1:
        return f"{name(best[0])} wins with {n} {picks}."
    return f"{names(best)} tie for the win with {n} {picks}."


def main_loop():
    last_fetch = last_prune = last_error = 0
    while True:
        now = time.time()
        if ONLINE and now - last_fetch > 1:
            last_fetch = now
            try:
                refresh()
                if code and game.get("status") == "waiting" and now - last_prune > 8:
                    last_prune = now
                    rpc("prune_lobby", {"p_code": code})     # drop players who closed their browser
            except Exception as e:
                if now - last_error > 10:                    # don't flood the log every second
                    last_error = now
                    log("refresh failed:", e)
        time.sleep(0.3)


def status():
    """python3 brick.py --status : what the brick sees right now (run it while people are joining)."""
    print("secret key:", "OK" if ONLINE else "MISSING (fill in SUPABASE_SERVICE_KEY in .env)")
    print("auto-start at:", AUTO_START or "off", "| speaker id:", SPEAKER_ID)
    if not ONLINE:
        return
    try:
        open_games = get("games", select="*", status="in.(waiting,live)")
    except DbError as e:
        return print("can't read games:", e)
    if open_games and "speaker" not in open_games[0]:
        print("PROBLEM: games have no 'speaker' column. Run backend/speaker.sql in the Supabase SQL Editor.")
    mine = [g for g in open_games if g.get("speaker") == SPEAKER_ID]
    print("open games:", len(open_games), "| following this brick:", [g["code"] for g in mine] or "none")
    for g in open_games:
        if g.get("speaker") != SPEAKER_ID:
            print(f"  {g['code']} ({g['status']}) is NOT on this brick (speaker = {g.get('speaker')}). Start games by tapping the brick.")
    for g in mine:
        try:
            rows = get("results", select="user_id,profiles(username)", game=f"eq.{g['code']}")
            print(f"  {g['code']} ({g['status']}, {g.get('mode', 'solo')}): {len(rows)} player(s):", ", ".join(name(r) for r in rows) or "-")
        except DbError as e:
            print(f"  {g['code']}: can't read players:", e)


# ---------- start ----------
if __name__ == "__main__" and "--status" in sys.argv:
    status()
    sys.exit()

if __name__ == "__main__":
    from gpiozero import Button

    log("online mode:", ONLINE, "| touch pin:", TOUCH_PIN, "| auto-start at:", AUTO_START or "off")
    touch = Button(TOUCH_PIN, pull_up=None, active_state=True, hold_time=3)
    held = [False]
    taps = [0, None]          # taps so far, and the timer that decides once they stop

    def counted():
        n, taps[0] = taps[0], 0
        (on_tap if n == 1 else on_double if n == 2 else end_game)()

    def released():
        if held[0]:
            return
        taps[0] += 1
        if taps[1]:
            taps[1].cancel()
        taps[1] = threading.Timer(0.45, counted)     # wait a moment to see if another tap follows
        taps[1].start()

    touch.when_pressed = lambda: held.__setitem__(0, False)
    touch.when_held = lambda: (held.__setitem__(0, True), end_game())
    touch.when_released = released
    main_loop()
