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
   sudo apt install -y espeak-ng python3-requests
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

Want a nicer voice? Set `TTS_CMD` in `.env` to any command that takes the text as its last argument
(for example a small script that runs Piper and plays the result with `aplay`).

## Backup

If the brick isn't working, anyone logged in can run a game from `https://www.buzzkill.study/host`.
It plays the roasts out loud on the Bluetooth speaker if the Pi is online, or from the laptop if not.

## Wiring (Pi 4B, 3.3V only)

| Part | Pin | Pi pin |
|---|---|---|
| ST25DV64K NFC | VCC / GND / SDA / SCL | 1 / 6 / 3 / 5 |
| Touch sensor (TTP223) | VCC / GND / SIG | 17 / 9 / 11 (GPIO 17) |
| Speaker | Bluetooth (see above), or 3.5 mm jack / USB | |
