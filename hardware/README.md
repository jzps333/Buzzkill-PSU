# Hardware: the Buzzkill brick

A Raspberry Pi 4B in a box in the middle of the table. It runs the game with one touch pad, talks through a
Bluetooth speaker, and roasts whoever picks up their phone. Supabase is the referee; the Pi just listens and talks.

| Part | What it does |
|---|---|
| Raspberry Pi 4B + Grove Base Hat | runs `brick.py` and `speaker.py` |
| Grove Touch Sensor (port **D5**) | the only button: start, scoreboard, end |
| JBL Go 3 (Bluetooth) | the brick's voice: roasts + announcements (ElevenLabs) |
| NFC sticker / QR code on the lid | `https://buzzkill-psu.vercel.app/brick` → joins the brick's current game |
| Grove LCD 16x2 (optional, I2C) | PIN and live game info |
| Grove NFC ST25DV64 (optional, I2C) | the Pi can rewrite it per game, but it needs a separate 13.56 MHz antenna |

Two programs run on the Pi (both start on boot):
- **`brick.py`**: the touch sensor, the brick's announcements (PIN, scoreboard, time left) and the LCD.
- **`speaker.py`**: plays an AI roast on loop while someone is busted, stops while they shake.


## Quick start (on the Pi, over SSH)

First time only: `cd ~/Buzzkill-PSU/hardware && bash setup.sh && sudo reboot`, then pair the speaker (see [Pairing the JBL](#pairing-the-jbl-go-3)).

**1. Get the latest code**
```bash
cd ~/Buzzkill-PSU && git pull && cd hardware
```

**2. Connect the JBL Go 3** (turn it on; it's already paired)
```bash
bluetoothctl connect 18:90:67:DE:D2:E1      # wait for "Connection successful"
espeak-ng "Put your phone down"             # should come out of the JBL
```
No sound: `wpctl status`, find the JBL under Sinks, `wpctl set-default <number>`.

**3. Settings** (once)
```bash
cp -n .env.example .env     # the JBL address is already filled in
nano .env                   # paste the sb_secret key into SUPABASE_SERVICE_KEY, Ctrl+O Enter, Ctrl+X
```
The key is in Supabase → Project Settings → API Keys → Secret keys. `.env` is ignored by git: never commit the key.
Without it, tapping still works and the brick says "not connected to the game yet" (good for testing touch + speaker).

**4. Start it** (also starts on every boot)
```bash
systemctl --user enable --now buzzkill-speaker buzzkill
systemctl --user restart buzzkill-speaker buzzkill     # after every git pull
bash check.sh                                           # ✅ / ❌ for every part
journalctl --user -u buzzkill-speaker -u buzzkill -f    # live logs
```

**5. Play**

| You | The brick says (ElevenLabs voice) |
|---|---|
| **Tap** | "New game. Your PIN is 4, F, 2, A, 9, C." (**double tap** = teams game) |
| Players tap the NFC sticker, scan the QR, or type the PIN at buzzkill.study | |
| **Tap** (under 4 players) | the PIN again + who's in: "Need 2 more to start." |
| **Tap** (4+ players) | "Game on. Phones down. Good luck." |
| Someone picks up their phone | an AI roast on loop until they shake their phone |
| **Tap** during the game | time left + scoreboard: "Focus time, 18 minutes left. Alex is losing, with 3 pickups. Sam is still clean." |
| **Hold 3 s** | "Game over. Check your phones for results." (or closes a game that never started) |

Games started from the website's `/host` page with **Buzzkill speaker** picked work with the brick too.


## Troubleshooting

| Problem | Fix |
|---|---|
| No sound | `bluetoothctl connect 18:90:67:DE:D2:E1`, then `wpctl status` |
| Robot voice instead of ElevenLabs | `journalctl --user -u buzzkill -n 30` says why (key, credits, function not deployed) |
| Tap does nothing | `journalctl --user -u buzzkill -n 30` |
| Logs say 401 / Invalid API key | the key in `.env` is wrong or still the placeholder |
| Logs mention the `speakers` table | run `backend/speaker.sql` in the Supabase SQL Editor |
| Anything else | `bash check.sh` |

**Backup:** if the brick is down, anyone logged in can run a game from `https://www.buzzkill.study/host`.
It plays the roasts on the brick's speaker if `speaker.py` is online, or from the laptop if not.


## Wiring (Grove Base Hat)

Everything plugs into the Grove Base Hat with Grove cables. No loose wires.

| Part | Port | Pi pins |
|---|---|---|
| Touch sensor | **D5** | GPIO 5 (another D port: set `TOUCH_PIN` in `.env`, e.g. D16 = 16) |
| LCD (optional) | any **I2C** port | SDA / SCL, address `3e` |
| NFC board (optional) | any **I2C** port | SDA / SCL, addresses `53`, `57`, `2d` |
| JBL Go 3 | Bluetooth | |

Don't use the **A0 / A2 / A4 / A6** ports: they go to the hat's analog chip, not to the Pi's pins.
Test the parts on their own: `python3 test_touch.py`, `python3 lcd.py "Hello" "World"`, `i2cdetect -y 1`.


## Pairing the JBL Go 3

Our speaker's address is `18:90:67:DE:D2:E1`. Turn it on and hold its Bluetooth button until it flashes blue fast
(turn Bluetooth off on any phone it was connected to). Then type these **one at a time** (pasting several lines doesn't work):
```bash
sudo rfkill unblock bluetooth
bluetoothctl
```
```
power on
scan on                        # wait for: [NEW] Device 18:90:67:DE:D2:E1 JBL Go 3
pair 18:90:67:DE:D2:E1         # right away, WHILE it's still scanning
trust 18:90:67:DE:D2:E1
connect 18:90:67:DE:D2:E1      # wait for "Connection successful"
scan off
info 18:90:67:DE:D2:E1         # Paired: yes, Trusted: yes, Connected: yes
exit
```

| You see | Means / fix |
|---|---|
| `Device ... not available` | the scan already stopped: `scan on` again and pair while it's scanning |
| `Failed to pair: AlreadyExists` | already paired: skip to `trust` and `connect` |
| Lots of `[DEL] Device ...` lines | normal: after `scan off` the Pi forgets the other nearby devices |
| `Failed to pair` (anything else) | `remove 18:90:67:DE:D2:E1`, pairing mode again, start over |
| `Failed to connect` | JBL is off or connected to a phone: turn that phone's Bluetooth off, `connect` again |

Once paired, `speaker.py` reconnects to `BT_SPEAKER_MAC` by itself every 10 seconds.
A different speaker: put its address in `.env` as `BT_SPEAKER_MAC`.


## How the Pi talks to the backend

Supabase is the referee: a database trigger counts pickups, runs the shake penalty and pays out
(see `backend/README.md`). The Pi uses the project's secret key and plain REST calls, about twice a second.

```
Phones ──events──► Supabase (database = referee) ◄──every 0.5 s── Pi
                                                    ├─ speaker.py → JBL: roasts busted players
                                                    └─ brick.py   → touch pad, announcements, LCD
```

**Which game the Pi follows:** the open game with `games.speaker = 'brick'`. The brick sets it when you tap to create a game,
and the `/host` page sets it when the host picks **Buzzkill speaker** (`set_game_speaker`). One game at a time.
`speaker.py` checks in every 5 seconds (`speakers.last_seen`) so `/host` shows the speaker online; after 20 s without
a check-in the laptop takes over the roasts.

**Touch pad → database:** `create_game(p_mode)`, `start_game(p_code)` (needs 4+ players, even teams),
`finish_game(p_code)` (ends + pays out), `cancel_game(p_code)`, and `prune_lobby(p_code)` every 8 s while waiting.

**When to roast:** play on loop while a player's `alarm_on` is true and they're not shaking.
- Pickup → `alarm_on = true` → roast plays
- Shaking → `is_shaking = true` → paused. Stopped early → plays again. Shook long enough → `alarm_on = false`, silent.
- Shaking but no new shake for 2 s (phone died, lost signal) → counts as stopped.
- Teams: one pickup busts the whole team; they share one roast about `alarm_cause` (who slipped).

**AI voice:** the `roast` Supabase Edge Function. `{game, user_id}` → Gemini writes a roast from the player's real stats,
ElevenLabs voices it (mp3). `{say: "text"}` → any short line in the same voice (the brick's announcements).
If it fails, the Pi reads the text with espeak-ng, or uses a built-in roast. `AI_ROASTS=0` in `.env` = always espeak.


## Files

| File | What it is |
|---|---|
| `brick.py` | touch pad, announcements, LCD; runs as `buzzkill.service` |
| `speaker.py` | roasts on the Bluetooth speaker; runs as `buzzkill-speaker.service` (`--test` says one roast) |
| `setup.sh` | one-time install: packages, I2C, PipeWire Bluetooth audio, both services |
| `check.sh` | checks settings, speaker, backend, LCD and services, with a fix for each ❌ |
| `lcd.py` | Grove 16x2 LCD driver (`python3 lcd.py "top" "bottom"` to test) |
| `nfc.py` | writes a link to the ST25DV64 NFC board (`--read`, `--check`, `--fix-rf`) |
| `test_touch.py` | prints `touched` when you touch the pad |
| `.env.example` | settings template: copy to `.env` and add the secret key |
