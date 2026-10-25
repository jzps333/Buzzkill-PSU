# Hardware

Raspberry Pi 4B code for the brick: NFC tag (ST25DV64K), touch sensor, speaker.

## What the Pi does (the database does the rest)

Supabase is the referee: it counts pickups, runs the shake penalty, and pays out.
The Pi only needs to do 3 things, using the secret key in `.env`:

**1. Touch sensor → run the game** (call these Supabase functions):

| Touch | Call | What happens |
|---|---|---|
| Tap (no game) | `create_game()` → returns a code like `4F2A9C` | Write `https://www.buzzkill.study/join?room=CODE` to the NFC tag |
| Tap (waiting) | `start_game(p_code)` | Game goes live. Fails with an error if fewer than 4 players joined, so play a "need more players" sound |
| Hold 3 s | `finish_game(p_code)` | Game ends, SOL payouts are calculated |

```python
code = sb.rpc("create_game").execute().data
sb.rpc("start_game", {"p_code": code}).execute()
sb.rpc("finish_game", {"p_code": code}).execute()
```

**2. Listen for alarms → play sounds.** Subscribe to Realtime `UPDATE`s on the `results` table
(filter `game=eq.CODE`). Each row has `user_id`, `alarm_on`, `is_shaking`, `pickups`, `shake_secs_needed`, `shake_secs_done`.

**Play the roast on loop while `alarm_on` is true AND `is_shaking` is false.** Otherwise, stay silent.

- Pickup → `alarm_on = true` → sound plays
- They start shaking → `is_shaking = true` → pause the sound
- They stop before their time is up → `is_shaking = false` → sound plays again
- They shook long enough → `alarm_on = false` → sound off for good

Safety rule: while someone is shaking, their row updates about twice a second. If you get no update
for 2 seconds while `is_shaking` is still true (their phone died or lost signal), treat it as stopped and play the sound.

**3. Players joining:** nothing to do. Phones handle it, and new rows show up in `results`.

## Backup

If the brick isn't working, anyone logged in can run a game from `https://www.buzzkill.study/host`.
It can also play the roasts out loud from the laptop.

## Wiring (Pi 4B, 3.3V only, never 5V)

| Part | Wire | Pi pin |
|---|---|---|
| ST25DV64K NFC | VCC | 1 (3.3V) |
| | GND | 6 |
| | SDA | 3 (GPIO 2) |
| | SCL | 5 (GPIO 3) |
| Touch sensor (TTP223) | VCC | 17 (3.3V) |
| | GND | 9 |
| | SIG / I/O | 11 (GPIO 17) |
| JBL Go 3 | no wires, Bluetooth (it has no aux jack) | |

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
Tap a phone on the tag's antenna (the flat coil). iPhone: screen on, top edge of the phone. Android: NFC on, middle of the back.

**2. Touch sensor:** `python3 test_touch.py`, touch the pad, it should print `touched`.

**3. JBL Go 3** — hold its Bluetooth button until it flashes blue fast, then:
```bash
bluetoothctl
  power on
  scan on            # wait for "JBL GO 3" and copy its address, e.g. AA:BB:CC:DD:EE:FF
  pair AA:BB:CC:DD:EE:FF
  trust AA:BB:CC:DD:EE:FF
  connect AA:BB:CC:DD:EE:FF
  exit
espeak-ng "Put your phone down"  # should come out of the JBL
```
If it plays from the wrong place: `wpctl status`, find the JBL under Sinks, `wpctl set-default <its number>`.

**4. Run it:** put the speaker address in `.env` as `SPEAKER_MAC=...` (and the `sb_secret` key if you want games), then
```bash
systemctl --user enable --now buzzkill    # starts now and on every boot
journalctl --user -u buzzkill -f          # watch the logs
```
Without the secret key the brick just points the tag at the website and talks when touched. With it, tap/hold runs games as described above.
