# Buzzkill 🐝

**A study brick that roasts you out loud when you pick up your phone.** Built at the Fall 2026 PSU hackathon.

Your study group puts their phones face down around the brick. The moment someone lifts theirs, the brick's speaker
calls them out by name with an AI-written roast, and it doesn't stop until they **shake their phone** for 10 seconds
(longer every time they slip). Everyone sees who folded first.

- **Live site:** https://www.buzzkill.study (also https://buzzkill-psu.vercel.app)
- **Join the brick's game:** https://buzzkill-psu.vercel.app/brick (what the NFC sticker and QR code on the brick open)

## The problem

Group study sessions die by a thousand notifications. Screen-time apps are private and easy to ignore.
Buzzkill makes slipping **public, funny and a little painful**: peer pressure, out loud, in real time.

## How a game works

1. **Tap the brick.** It says the PIN out loud: *"New game. Your PIN is 4, F, 2, A, 9, C."*
2. **Join from your phone:** tap the NFC sticker, scan the QR code, or type the PIN at buzzkill.study. Log in with Google, email, or as a guest. You need 4+ players.
3. **Vote on a pomodoro** (sprint / classic / deep). Tap the brick any time to hear the PIN and who's in. The game starts by itself 5 seconds after the 4th player joins. Phones go face down.
4. **Pick up your phone** (or leave the page) and you're busted: the brick roasts you on loop, by name, using your real stats.
5. **Shake your phone** to shut it up. 10 s the first time, 30 s the second, 1 min the third...
6. **Tap the brick** any time for the time left and the scoreboard. **Triple tap** (or hold for 3 seconds) to end the game: it says who won.
   One more tap starts the next game, and everyone's results page shows a **Join** button for it.
7. **Results:** titles (Iron Will, Doomscroller, First to Fold), the leaderboard, your rivals and your nemesis.

**Teams mode** (double tap with no game): even teams (2v2, 3v3...), one slip busts your whole team.
**Emergency pass:** once per game, cancel a pickup and get 10 free minutes for a real emergency.
Breaks in the pomodoro don't count.

## Architecture

```
 Phones (website)                      Supabase                              The brick (Raspberry Pi)
 ───────────────                       ────────                              ────────────────────────
 motion sensor: lifted? ──pickup──►   events table                          brick.py:  touch pad, PIN, scoreboard
 left the page?  ───────left_page─►     │ trigger = the referee             speaker.py: roasts on the JBL
 shaking? ──────────────shake────►     ▼                                         ▲
                                      results: pickups, alarm_on, ──────────────┘ polls every 0.5 s
 live updates ◄──── Realtime ───────  is_shaking, shake time
                                      roast Edge Function: Gemini writes, ElevenLabs speaks ──► mp3 to the Pi
```

- **The database is the referee.** Phones only send events. A Postgres trigger counts pickups, sets the alarm,
  adds up shaking time and decides the winner, so nobody can cheat from their phone.
- **The phone is the sensor.** The website reads the accelerometer: face down → lifted = pickup, hard jolts = shaking.
  Leaving the page counts too. (A website can't see which app you opened, so we catch the pickup itself.)
- **The brick is the voice.** The Pi follows its game in Supabase and plays the roasts on a Bluetooth speaker.
  If the Pi is down, the host's laptop takes over from the `/host` page.

## Tech

| Part | Built with |
|---|---|
| Website | plain HTML/JS on Vercel, Supabase JS, device motion + wake lock APIs |
| Backend | Supabase: Postgres, row-level security, triggers, Realtime, Auth (Google, email, guests) |
| AI roasts | Supabase Edge Function: Gemini (writes from real stats, new style every time) + ElevenLabs (voice) |
| Hardware | Raspberry Pi 4B, Grove Base Hat, touch sensor, JBL Go 3 over Bluetooth, NFC sticker + QR code |
| Security | RLS on every table, only the host or the Pi can run a game or spend AI credits, phone-only joining, escaped usernames, strict CSP |

**SOL stakes:** profiles can hold a Solana wallet, and `finish_game` already calculates payouts for staked games
(0.02 SOL per pickup goes to the players who stayed clean). On-chain staking from the lobby is not live yet.

## Repo map

| Folder | What's inside |
|---|---|
| [`frontend/`](frontend) | the website: landing + PIN, login, game (`join`), `host`, results, leaderboard, dashboard, friends, `brick` |
| [`backend/`](backend) | Supabase SQL: tables, security, game rules, teams, pomodoro, lobby. [README](backend/README.md) |
| [`supabase/functions/roast`](supabase/functions/roast) | the AI roast Edge Function (Gemini + ElevenLabs) |
| [`hardware/`](hardware) | the brick's Raspberry Pi code: touch pad and speaker. [README](hardware/README.md) |

## Run it yourself

- **Website:** import the repo in Vercel and deploy (`vercel.json` points it at `frontend/`). Every push to `main` redeploys.
  On your computer: `python3 serve.py`, then open http://localhost:8000 (short links like `/leaderboard` work, like on Vercel).
- **Backend:** see [`backend/README.md`](backend/README.md): run the SQL files in order, turn on guest sign-ins.
- **AI roasts:** Supabase → Edge Functions → deploy `roast` with **Verify JWT off**, then add the secrets
  `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` (optional: `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`, `GEMINI_MODEL`).
  Without keys it falls back to built-in roasts.
- **The brick:** see [`hardware/README.md`](hardware/README.md): `bash setup.sh`, pair the speaker, add the key, done.
  Before a demo, follow its [demo day checklist](hardware/README.md#demo-day-checklist-follow-this-exactly).
