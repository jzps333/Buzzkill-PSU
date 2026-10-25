# Hardware

Raspberry Pi 4B code for the brick: NFC tag (ST25DV64K), touch sensor, speaker.

## What the Pi does (the database does the rest)

Supabase is the referee: it counts pickups, runs the shake penalty, and pays out.
The Pi only needs to do 3 things, using the secret key in `.env`:

**1. Touch sensor → run the game** (call these Supabase functions):

| Touch | Call | What happens |
|---|---|---|
| Tap (no game) | `create_game()` (solo) or `create_game({"p_mode": "teams"})` → returns a code like `4F2A9C` | Write `https://www.buzzkill.study/join?room=CODE` to the NFC tag |
| Tap (waiting) | `start_game(p_code)` | Game goes live. Fails with an error if fewer than 4 players joined (or an odd number in teams mode: teams are always 2v2, 3v3...), so play a "need more players" sound |
| Hold 3 s | `finish_game(p_code)` | Game ends, SOL payouts are calculated |
| (optional) | `cancel_game(p_code)` | Close a game that hasn't started yet |

```python
code = sb.rpc("create_game").execute().data
sb.rpc("start_game", {"p_code": code}).execute()
sb.rpc("finish_game", {"p_code": code}).execute()
```

**2. Listen for alarms → play sounds.** This part is done: `speaker.py` (see "Bluetooth speaker" below). Subscribe to Realtime `UPDATE`s on the `results` table
(filter `game=eq.CODE`). Each row has `user_id`, `alarm_on`, `is_shaking`, `pickups`, `shake_secs_needed`, `shake_secs_done`.

**Play the roast on loop while `alarm_on` is true AND `is_shaking` is false.** Otherwise, stay silent.

- Pickup → `alarm_on = true` → sound plays
- They start shaking → `is_shaking = true` → pause the sound
- They stop before their time is up → `is_shaking = false` → sound plays again
- They shook long enough → `alarm_on = false` → sound off for good

Safety rule: while someone is shaking, their row updates about twice a second. If you get no update
for 2 seconds while `is_shaking` is still true (their phone died or lost signal), treat it as stopped and play the sound.

In **teams** mode, one pickup turns `alarm_on` on for every player on that team, so several rows can be busted at once.
Play the sound while ANY player is busted and not shaking. `alarm_cause` says whose pickup it was (good for the roast: "Alex slipped!").

**AI roasts (Gemini writes it, ElevenLabs says it).** Done in `speaker.py`. When a new pickup happens, ask for a roast once,
then loop that mp3 with the same rules as above. Teams: ask once, for the `alarm_cause` player.

```python
import requests, os
r = requests.post(f"{os.environ['SUPABASE_URL']}/functions/v1/roast",
                  headers={"apikey": os.environ["SUPABASE_SERVICE_KEY"], "Content-Type": "application/json"},
                  json={"game": code, "user_id": busted_user_id}, timeout=12)
if r.headers.get("content-type", "").startswith("audio"):
    open("/tmp/roast.mp3", "wb").write(r.content)      # play on loop, e.g. mpg123 --loop -1 /tmp/roast.mp3
else:
    text = r.json().get("text")                          # no voice available: use espeak, or a built-in sound
```
It takes 1-3 seconds, so play a buzzer sound while waiting. If it fails, play your built-in roasts.

**Optional, nice for the demo:** announce breaks. The game row has `start_time`, `pomo_work` and `pomo_break` (minutes);
call `on_break(p_code)` to check, and say "Break time!" / "Break's over, phones down!" when it changes.

**3. Players joining:** phones handle it, and new rows show up in `results`. While the game is waiting,
call `prune_lobby(p_code)` every ~8 seconds so players who closed their browser get removed
(rows are deleted, so listen for Realtime `DELETE`s too if you show a player count).

## Bluetooth speaker (speaker.py)

The Pi reads the roasts out loud on a Bluetooth speaker, so the host's laptop doesn't have to.

How it fits together:
- `speaker.py` checks in with Supabase every 5 seconds (`speakers` table), so the host page shows **Buzzkill speaker** with a green dot.
- When a host opens a game on `/host` and the speaker is online, the page sends that game's roasts to the Pi automatically
  (`set_game_speaker`). The host can switch between **Buzzkill speaker**, **This laptop** and **Off** at any time.
- The Pi only talks for the game that picked it. One game at a time: the last game to pick the speaker gets it.
- If the Pi goes offline mid-game (no check-in for 20 s), the laptop takes over until it's back.

### Setup (once, on the Pi)

1. Run `backend/speaker.sql` in the Supabase SQL Editor (once for the project).
2. Install the voice and get the code:
   ```bash
   sudo apt install -y espeak-ng mpg123 python3-requests
   git clone https://github.com/jzps333/Buzzkill-PSU ~/Buzzkill-PSU
   cd ~/Buzzkill-PSU/hardware && cp .env.example .env   # then paste the secret key into .env
   ```
3. Pair the speaker (put it in pairing mode first):
   ```bash
   bluetoothctl
     scan on              # wait for your speaker to show up, copy its address (AA:BB:CC:DD:EE:FF)
     pair AA:BB:CC:DD:EE:FF
     trust AA:BB:CC:DD:EE:FF
     connect AA:BB:CC:DD:EE:FF
     exit
   ```
   Put that address in `.env` as `BT_SPEAKER_MAC` and the Pi reconnects to the speaker whenever it drops.
4. Test it: `python3 speaker.py --test` should say a roast out of the speaker.
   No sound? Run `wpctl status` and make sure the Bluetooth speaker is the default sink (`wpctl set-default <id>`).
5. Start it on boot. It runs as your user (not root) so it can reach the Bluetooth audio:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp ~/Buzzkill-PSU/hardware/buzzkill-speaker.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now buzzkill-speaker
   sudo loginctl enable-linger $USER      # keep it running without anyone logged in
   journalctl --user -u buzzkill-speaker -f   # watch the logs
   ```

It plays the same AI roasts as the host page (one per pickup; in teams, one per slip for the whole team).
If the roast function is down or out of credits, it reads the text with espeak-ng, or uses a built-in roast.
Set `AI_ROASTS=0` in `.env` to skip the AI and save credits.

## Backup

If the brick isn't working, anyone logged in can run a game from `https://www.buzzkill.study/host`.
It plays the roasts out loud on the Bluetooth speaker if the Pi is online, or from the laptop if not.

## Wiring (Grove Base Hat on the Pi)

Everything plugs into the Grove Base Hat with the Grove cables. No loose wires.

| Part | Plug into | Pi pins it uses |
|---|---|---|
| Grove NFC (ST25DV64) | any port labeled **I2C** (right column) | SDA / SCL (GPIO 2 / 3) |
| Grove LCD RGB Backlight v4.0 | another **I2C** port | SDA / SCL (address 3e; used black and white) |
| Grove Touch Sensor | port **D5** | GPIO 5 (set `TOUCH_PIN` in `.env` if you use another D port: D16 = 16, D18 = 18, ...) |
| JBL Go 3 | no cable, Bluetooth (it has no aux jack) | |

The Grove NFC board has **no antenna built in**. Phones can't see it until a 13.56 MHz NFC antenna coil is plugged into its antenna connector
(the Pi can still read and write it without one).

Don't use the **A0 / A2 / A4 / A6** ports: those go to the hat's analog chip, not to the Pi's pins.

## Getting it running (over SSH)

```bash
git clone https://github.com/jzps333/Buzzkill-PSU.git ~/Buzzkill-PSU   # or: cd ~/Buzzkill-PSU && git pull
cd ~/Buzzkill-PSU/hardware
bash setup.sh
sudo reboot                      # only needed the first time, so I2C turns on
```

**1. NFC tag** — check the Pi sees it, then write the link:
```bash
i2cdetect -y 1                   # should show 53 and 57 (and maybe 2d)
python3 nfc.py                   # tag now opens https://buzzkill-psu.vercel.app/
```
`python3 nfc.py --check` shows if anything on the chip blocks phones. Tap a phone on the antenna coil. iPhone: screen on, top edge of the phone. Android: NFC on, middle of the back.

**2. Touch sensor:** `python3 test_touch.py`, touch the pad, it should print `touched`.

**3. JBL Go 3 (Bluetooth)** — our speaker's address is `18:90:67:DE:D2:E1`.

Turn the JBL on and hold its Bluetooth button until it flashes blue fast (turn Bluetooth off on any phone it's connected to).
Then type these **one at a time** inside `bluetoothctl` (pasting several lines at once doesn't work):
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
info 18:90:67:DE:D2:E1         # should say Paired: yes, Trusted: yes, Connected: yes
exit
```
Back in the normal terminal: `espeak-ng "Put your phone down"` should come out of the JBL.
If it plays somewhere else: `wpctl status`, find the JBL's number under Sinks, `wpctl set-default <number>`.

| You see | Means / fix |
|---|---|
| `Device ... not available` | The scan already stopped. `scan on` again and pair while it's scanning |
| `Failed to pair: AlreadyExists` | Already paired. Skip to `trust` and `connect` |
| Lots of `[DEL] Device ...` lines | Normal: after `scan off` the Pi forgets the other nearby devices |
| `Failed to pair` (anything else) | `remove 18:90:67:DE:D2:E1`, put the JBL in pairing mode, start again |
| `Failed to connect` | JBL is off or connected to a phone. Turn that phone's Bluetooth off, `connect` again |

Once paired, the Pi reconnects by itself: put `BT_SPEAKER_MAC=18:90:67:DE:D2:E1` in `.env` and `speaker.py` checks every 10 s.
Test with `python3 speaker.py --test` (says a roast).

**4. Run it:** paste the `sb_secret` key into `.env`, then
```bash
systemctl --user enable --now buzzkill-speaker buzzkill   # starts now and on every boot
journalctl --user -u buzzkill-speaker -u buzzkill -f       # watch the logs
```
Two programs run on the Pi:
- `brick.py`: touch sensor + LCD (+ the NFC board, if it ever gets an antenna).
- `speaker.py`: plays the roasts for whichever game picked this speaker (see "Bluetooth speaker" above).

**Touch sensor**

The speaker answers every tap:

| Touch | No game | Waiting for players | Live |
|---|---|---|---|
| Tap | **activates**: new **solo** game, says the PIN | under 4 players: says the PIN and who's in. 4+: starts the game | says the time left and the scoreboard ("Alex is losing, with 3 pickups, down 0.06 SOL. Sam is still clean.") |
| Double tap | new **teams** game | | |
| Hold 3 s | | close it | end it + pay out |

**LCD** (`python3 lcd.py "Hello" "World"` to test)

| When | Shows | Color |
|---|---|---|
| No game | `BUZZKILL` / `Tap=solo 2x=team` | yellow |
| Waiting | `PIN 4F2A9C` / `3/4 joined` (switches with `buzzkill.study`) | yellow |
| Live | pomodoro `FOCUS 18:20` + pickups, then (tap) most focused, most pickups, PIN | green, blue on break |
| Someone picked up | `BUSTED: Alex` / `Shake to stop!` | red |

Games started from `/host` with the Buzzkill speaker show up on the LCD too.

`i2cdetect -y 1` should show **3e**. The screen is used black and white: on our hat its backlight chip (62) doesn't
show up (it likely needs 5V), so the Color column above is ignored.

**NFC stickers / QR code:** write `https://buzzkill-psu.vercel.app/brick` on them (NFC Tools app → Write → URL).
That page always forwards to the game the brick is running, so one sticker works for every game.

Without the secret key, `brick.py` just points the tag at the website and talks when touched.

**5. Check everything:** `bash check.sh` tests the speaker, the backend, the NFC tag, the touch sensor and both services,
and prints ✅ or ❌ with what to do for each.
