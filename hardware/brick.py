"""The Buzzkill brick: touch sensor + LCD screen (+ NFC board if one is plugged in).
Roasts on the speaker are speaker.py's job.

Touch sensor (the speaker answers every tap):
  tap         no game -> new SOLO game (right after a game ends too: one tap = the next game)
              waiting -> says the PIN and how many people are in (every time, until the game starts)
              live    -> says the time left and the scoreboard (and flips the LCD page)
  double tap  no game -> new TEAMS game
              waiting -> start the game (4+ players)
  triple tap  end the game and say who won (or close it if it never started)
  hold 3 s    same as triple tap

LCD: the PIN to join while waiting, then the clock / pomodoro, who's busted, who's winning.
The brick follows any open game that uses this speaker, so games started from /host show up too.
The NFC sticker / QR code on the brick points at /brick, which always forwards to this game.
"""
import os
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from gpiozero import Button

import lcd

HERE = Path(__file__).resolve().parent
for line in (HERE / ".env").read_text().splitlines() if (HERE / ".env").exists() else []:
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

SITE = os.environ.get("SITE_URL", "https://buzzkill-psu.vercel.app").rstrip("/")
JOIN_HINT = os.environ.get("JOIN_HINT", "buzzkill.study")      # shown under the PIN
SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SPEAKER_ID = os.environ.get("SPEAKER_ID", "brick")
TOUCH_PIN = int(os.environ.get("TOUCH_PIN", "5"))   # Grove port D5 = GPIO 5
ONLINE = SB_KEY.startswith("sb_secret")
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

code = None          # current room code
game = {}            # its games row
players = []         # its results rows
page = 0             # LCD page while live
flash = None         # (top, bottom, color, until): a short message that wins over everything
lock = threading.Lock()


# ---------- screen, voice, NFC ----------
class NoScreen:
    def show(self, *a, **k):
        pass


try:
    screen = lcd.LCD()
except Exception as e:
    print("No LCD found (plug it into an I2C port):", e)
    screen = NoScreen()


def note(top, bottom, color, secs=3):
    global flash
    flash = (top, bottom, color, time.time() + secs)


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
    print("say:", text)
    threading.Thread(target=_say, args=(short(text), said), daemon=True).start()


def _say(text, n):
    global voice
    mp3 = eleven(text)                  # takes a second or two
    if n != said:
        return                          # someone tapped again meanwhile: only the newest line plays
    if voice and voice.poll() is None:
        voice.kill()                    # cut off the last announcement
    cmd = ["mpg123", "-q", mp3] if mp3 else ["espeak-ng", "-v", "en-us", "-s", "150", "-a", "200", text]
    voice = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def tag(url):
    # The Grove NFC board is optional (it needs an antenna). Stickers point at /brick instead.
    try:
        import nfc
        nfc.write_url(url)
    except Exception:
        pass


# ---------- Supabase (plain REST, secret key = acts as the Pi) ----------
def rpc(name, args=None):
    r = requests.post(f"{SB_URL}/rest/v1/rpc/{name}", json=args or {}, headers=HEADERS, timeout=10)
    if r.status_code >= 300:
        raise RuntimeError(r.json().get("message", r.text))
    return r.json() if r.text else None


def get(table, **params):
    r = requests.get(f"{SB_URL}/rest/v1/{table}", params=params, headers=HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()


# ---------- touch sensor ----------
def new_game(mode):
    global code, page
    with lock:
        try:
            code, page = rpc("create_game", {"p_mode": mode}), 0
            try:
                rpc("set_game_speaker", {"p_code": code, "p_speaker": SPEAKER_ID})
            except Exception as e:
                print("speaker not set (is speaker.py running?):", e)
            tag(f"{SITE}/join?room={code}")
            print("new", mode, "game", code)
            say(("New team game. " if mode == "teams" else "New game. ") + pin_line())
        except Exception as e:
            print("create failed:", e)
            note("Can't start game", "Check internet", lcd.RED)


def on_tap():
    global page
    if not ONLINE:
        note("No secret key", "Fill in .env", lcd.RED)
        say("Buzzkill is ready, but not connected to the game yet. Add the secret key.")
        return
    if code is None:
        return new_game("solo")
    status = game.get("status")
    if status == "waiting":
        note(f"PIN {code}", f"{len(players)}/4 joined", lcd.HONEY, 5)
        say(lobby_line())
    elif status == "live":
        page += 1
        say(time_line() + " " + score_line())


def start():
    if game.get("status") == "waiting":
        with lock:
            try:
                rpc("start_game", {"p_code": code})
                say("Game on. Phones down. Good luck.")
            except Exception as e:
                print("start failed:", e)
                if "4 players" in str(e):
                    note("Need 4 players", f"Have {len(players)}", lcd.RED)
                    say("Need at least 4 players.")
                else:
                    note("Can't start", str(e)[:16], lcd.RED)


def on_double():
    if not ONLINE:
        return on_tap()
    if code is None:
        new_game("teams")
    elif game.get("status") == "waiting":
        start()
    else:
        on_tap()


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
            print("end failed:", e)
        reset()
    if live:
        note("Game over!", "Tap = new game", lcd.WHITE, 8)
        say(f"Game over. {winner_line(final)} Tap to start a new game.")
    else:
        note("Game closed", "Tap = new game", lcd.WHITE, 8)
        say("Game closed. Tap to start a new game.")


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


def reset():
    global code, game, players
    code, game, players = None, {}, []
    tag(SITE + "/brick")


# ---------- keep up with the game ----------
def refresh():
    """Find the brick's game and read it. Returns False when there's nothing to show."""
    global code, game, players
    if code is None:
        found = get("games", select="code", speaker=f"eq.{SPEAKER_ID}", status="in.(waiting,live)")
        if not found:
            return
        code = found[0]["code"]                      # e.g. a game started from /host
    rows = get("games", code=f"eq.{code}", select="status,mode,start_time,pomo_work,pomo_break,speaker")
    if not rows or rows[0]["status"] in ("ended", "cancelled") or rows[0]["speaker"] != SPEAKER_ID:
        if rows and rows[0]["status"] == "ended":
            note("Game over!", "Check your phone", lcd.WHITE, 8)
        with lock:
            reset()
        return
    game = rows[0]
    players = get("results", game=f"eq.{code}", select="user_id,pickups,alarm_on,sol_in,profiles(username)")


def name(p):
    return (p.get("profiles") or {}).get("username") or "player"


def clock(secs):
    secs = max(0, int(secs))
    return f"{secs // 60}:{secs % 60:02d}"


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


def pin_line():
    return "Your PIN is " + ", ".join(code) + "."             # "4, F, 2, A, 9, C": read one by one


def lobby_line():
    n = len(players)
    who = f"{n} player{'s' if n != 1 else ''} in" + (f": {names(players)}." if players else ".")
    if n < 4:
        return f"{pin_line()} {who} Need {4 - n} more to start."
    return f"{pin_line()} {who} Double tap to start."


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
    lost = min(n * 0.02, float(worst.get("sol_in") or 0))          # same 0.02 SOL per pickup as finish_game
    line += f", down {lost:.2f} SOL." if lost else "."
    clean = [p for p in players if p["pickups"] == 0]
    if clean:
        line += f" {names(clean)} {'is' if len(clean) == 1 else 'are'} still clean."
    else:
        best = min(players, key=lambda p: p["pickups"])
        line += f" {name(best)} is winning, with {best['pickups']}."
    return line


def render():
    now = time.time()
    if flash and now < flash[3]:
        return screen.show(*flash[:3])
    if not ONLINE:
        return screen.show("    BUZZKILL", "Add key to .env", lcd.HONEY)
    if code is None:
        return screen.show("    BUZZKILL", "Tap=solo 2x=team", lcd.HONEY)

    if game.get("status") == "waiting":
        n = len(players)
        team = " TEAMS" if game.get("mode") == "teams" else ""
        bottom = (JOIN_HINT if int(now / 3) % 2 else
                  f"{n}/4 joined" if n < 4 else f"{n} in! Tap=start")
        return screen.show(f"PIN {code}{team}", bottom, lcd.HONEY)

    # Live
    busted = [p for p in players if p["alarm_on"]]
    if busted:
        return screen.show("BUSTED: " + ", ".join(name(p) for p in busted), "Shake to stop!", lcd.RED)

    on_break, left, t = timer()
    clock_line = f"LIVE {clock(t)}" if left is None else f"{'BREAK' if on_break else 'FOCUS'} {clock(left)}"
    total = sum(p["pickups"] for p in players)
    ranked = sorted(players, key=lambda p: p["pickups"])
    pages = [
        (clock_line, f"Pickups: {total}"),
        ("Most focused:", f"{name(ranked[0])} ({ranked[0]['pickups']})" if ranked else "-"),
        ("Most pickups:", f"{name(ranked[-1])} ({ranked[-1]['pickups']})" if ranked else "-"),
        (f"PIN {code}", f"{len(players)} playing"),
    ]
    screen.show(*pages[page % len(pages)], lcd.BLUE if on_break else lcd.GREEN)


def main_loop():
    last_fetch = last_prune = 0
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
                print("refresh failed:", e)
        try:
            render()
        except Exception as e:
            print("screen failed:", e)
        time.sleep(0.3)


# ---------- start ----------
if __name__ == "__main__":
    tag(SITE + "/brick")
    print("online mode:", ONLINE, "| touch pin:", TOUCH_PIN)

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
