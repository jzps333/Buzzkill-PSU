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

**2. Listen for alarms → play sounds.** Subscribe to Realtime `UPDATE`s on the `results` table
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

## Backup

If the brick isn't working, anyone logged in can run a game from `https://www.buzzkill.study/host`.
It can also play the roasts out loud from the laptop.

## Wiring (Pi 4B, 3.3V only)

| Part | Pin | Pi pin |
|---|---|---|
| ST25DV64K NFC | VCC / GND / SDA / SCL | 1 / 6 / 3 / 5 |
| Touch sensor (TTP223) | VCC / GND / SIG | 17 / 9 / 11 (GPIO 17) |
| Speaker | 3.5 mm jack or USB | |
