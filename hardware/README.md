# Hardware

Raspberry Pi 4B code for the brick: NFC tag (ST25DV64K), touch sensor, speaker.

## What the Pi does (the database does the rest)

Supabase is the referee: it counts pickups, runs the shake penalty, and pays out.
The Pi only needs to do 3 things, using the secret key in `.env`:

**1. Touch sensor → run the game** (call these Supabase functions):

| Touch | Call | What happens |
|---|---|---|
| Tap (no game) | `create_game()` → returns a code like `4F2A9C` | Write `https://www.buzzkill.study/join?room=CODE` to the NFC tag |
| Tap (waiting) | `start_game(p_code)` | Game goes live |
| Hold 3 s | `finish_game(p_code)` | Game ends, SOL payouts are calculated |

```python
code = sb.rpc("create_game").execute().data
sb.rpc("start_game", {"p_code": code}).execute()
sb.rpc("finish_game", {"p_code": code}).execute()
```

**2. Listen for alarms → play sounds.** Subscribe to Realtime `UPDATE`s on the `results` table
(filter `game=eq.CODE`). Each row has `user_id`, `alarm_on`, `pickups`, `shakes_needed`, `shakes_done`.

- `alarm_on` turns **true** → play a roast on loop (look up the name in `profiles.username`)
- `alarm_on` turns **false** → stop it (they shook it off)

**3. Players joining:** nothing to do. Phones handle it, and new rows show up in `results`.

## Backup

If the brick isn't working, anyone logged in can run a game from `https://www.buzzkill.study/host`.
It can also play the roasts out loud from the laptop.

## Wiring (Pi 4B, 3.3V only)

| Part | Pin | Pi pin |
|---|---|---|
| ST25DV64K NFC | VCC / GND / SDA / SCL | 1 / 6 / 3 / 5 |
| Touch sensor (TTP223) | VCC / GND / SIG | 17 / 9 / 11 (GPIO 17) |
| Speaker | 3.5 mm jack or USB | |
