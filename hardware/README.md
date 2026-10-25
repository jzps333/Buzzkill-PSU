# Hardware (Raspberry Pi 4B)

`game.py` is the game brain. It runs on the Pi, listens to Supabase live, and drives the brick.

## How a game works

1. **Tap** the touch sensor → new game. The Pi writes `https://buzzkill-psu.vercel.app/join?room=CODE` to the NFC tag.
2. Players tap their phones on the brick → the join page opens → they log in or play as guest.
3. **Tap** again (4+ players) → game starts.
4. Someone lifts their phone → the phone sends `pickup` → the Pi adds +1 and loops a roast on the speaker.
5. They **shake** their phone → roast stops.
6. **Hold** the sensor 3 seconds → game ends, SOL payouts are saved, winner announced.

## Run it

```bash
cd hardware
pip install -r requirements.txt --break-system-packages
sudo apt install -y espeak-ng          # backup voice
cp .env.example .env                   # then paste the sb_secret key into .env
python3 game.py
```

No touch sensor yet? Press **Enter** to tap, type **h** + Enter to hold.

## Hardware team: plug your code in here

Make `brick.py` in this folder with these 4 functions. `game.py` uses it automatically.
Until it exists, `game.py` uses fake versions that print and speak with espeak.

| Function | What it does |
|---|---|
| `write_tag(url)` | Writes the join link to the ST25DV NFC tag |
| `play(text, loop=False)` | Speaks / plays the roast on the speaker (loop until stopped) |
| `stop()` | Stops the speaker |
| `watch_touch(on_tap, on_hold)` | Calls `on_tap()` on a tap, `on_hold()` on a 3-second hold |

## Wiring (Pi 4B, 3.3V only)

| Part | Pin | Pi pin |
|---|---|---|
| ST25DV64K NFC | VCC / GND / SDA / SCL | 1 / 6 / 3 / 5 |
| Touch sensor (TTP223) | VCC / GND / SIG | 17 / 9 / 11 (GPIO 17) |
| Speaker | 3.5 mm jack or USB | |
