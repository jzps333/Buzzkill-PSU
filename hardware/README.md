# Hardware

Raspberry Pi 4B code for the brick: NFC tag (ST25DV64K), touch sensor, speaker.

## How the Pi talks to the website

The phones and the Pi never talk directly. They both use Supabase:

- Phones add rows to the `events` table: `join`, `pickup`, `left_page`, `shake`.
- The Pi listens to `events` live (Supabase Realtime) and reacts.
- The Pi creates rows in `games` and updates `results` (pickups, SOL back) using the secret key in `.env`.
- The NFC tag link format is `https://buzzkill-psu.vercel.app/join?room=CODE`.

Table details are in `backend/README.md`. An optional example Pi script is on the `pi-reference` branch.
