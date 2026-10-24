# Buzzkill

A study game for 4+ people. Everyone puts their phone face-down. If you pick yours up, a
Raspberry Pi speaker calls you out by name, using an ElevenLabs voice. **Shake your phone** to
make it stop. Every pickup costs you points, and the roast keeps repeating and costing you more
until you shake. The person with the most points when the timer ends gets bragging rights.
The person with the fewest gets one last roast.

**Mystery Stack:** Phone motion (flip and shake detection) · Rivalry (live leaderboard and
callouts) · Group of 4+ (a session won't start with fewer than 4 players).

## How it works

```
Phones (web page, no app)        Raspberry Pi                         Laptop / TV
  /  join, face-down, shake  ──▶  server.py (game + scores)  ◀──      /board  (start + leaderboard)
                                     └─ speech.py ─▶ ElevenLabs ─▶ speaker
```

| File | What it does |
|---|---|
| `server.py` | Game server: players, scoring, timer, WebSockets |
| `speech.py` | Text-to-speech: ElevenLabs, falls back to espeak if there's no key or no internet |
| `roasts.py` | Every line the speaker says. Edit these to make them funnier |
| `static/phone.js` | Phone sensors: face-down/pickup (orientation), shake (motion) |
| `static/board.js` | Leaderboard / start screen |

### Scoring
- +1 point per second your phone is face-down
- -50 when you pick it up (roast starts)
- -10 every time the roast repeats (every 8 seconds) until you **shake** the phone
- Phone still up 45 seconds after shaking: you get roasted again
- Leaving the page or locking the phone counts as a pickup

All of these numbers are at the top of `server.py`.

## Setup on the Raspberry Pi

### 1. Install stuff
```bash
sudo apt update
sudo apt install -y git python3-venv mpg123 espeak-ng
git clone https://github.com/jzps333/Buzzkill-PSU
cd Buzzkill-PSU
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Add your ElevenLabs key
```bash
cp .env.example .env
nano .env          # paste your key after ELEVENLABS_API_KEY=   then Ctrl+O, Enter, Ctrl+X
```
Get a key at elevenlabs.io → your profile → **API Keys**. To change the voice, copy a voice ID
from the ElevenLabs Voice Library into `ELEVENLABS_VOICE_ID`.

Spoken lines are cached in `cache/`, so a repeated line costs no extra credits. With no key, it
uses the robot voice (espeak), which is also pretty funny.

### 3. Plug in the speaker and test it
```bash
speaker-test -t wav -c 2 -l 1
```
If you hear nothing, run `sudo raspi-config` → System Options → Audio and pick your speaker.
Bluetooth speakers can be paired from the desktop's Bluetooth icon.

### 4. Run it
```bash
source .venv/bin/activate     # every time you open a new terminal
python server.py
```

### 5. Get an https link (needed for phone sensors)
iPhones and Android phones only share motion sensors with **https** sites. A free Cloudflare
tunnel gives you an https link. In a **second terminal** on the Pi:
```bash
# one-time install (64-bit Pi OS; for 32-bit swap arm64 for armhf)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# every time
cloudflared tunnel --url http://localhost:8000
```
It prints a link like `https://something-random.trycloudflare.com`.

- **Phones** open that link
- **Laptop / TV** opens that link + `/board`

### 6. Play
1. Everyone opens the link, types their name, taps **Allow motion & start**. On iPhone, tap Allow in the popup.
2. Keep the page open and put the phone **face-down** on the table.
3. On the board, pick a session length and press **Start session** (it needs at least 4 ready players).
4. Pick up your phone and get roasted. Shake to make it stop.

## Testing without 4 people
- Set `MIN_PLAYERS=1` in `.env`.
- Add `?debug=1` to the phone link (e.g. `http://localhost:8000/?debug=1`) to get buttons that
  fake face-down / pick up / shake. You can open several browser tabs as different players.
- Press **Test speaker** on the board to check the voice.

## Troubleshooting
| Problem | Fix |
|---|---|
| "Motion sensors only work over https" | Use the cloudflared link, not the Pi's IP address |
| iPhone: "Motion access was denied" | Fully close Safari, reopen the link, tap Allow |
| Pickups trigger too easily / not at all | Tweak the numbers at the top of `static/phone.js` |
| Shake doesn't register | Lower `SHAKE_FORCE` in `static/phone.js` |
| ElevenLabs error in the terminal | Check the key in `.env` and that you have credits left. It falls back to espeak meanwhile |
| No sound | `speaker-test` (step 3), and make sure `mpg123` is installed |
