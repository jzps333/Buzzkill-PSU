# Buzzkill-hackathon-PSU
This project is for the Fall26 hackathon this project is a study app that calls you names if you pick up your phone and to turn it off you have to shake it!


## Website

Live at **https://www.buzzkill.study** (also https://buzzkill-psu.vercel.app).

## Hosting the website on Vercel

1. Go to vercel.com → **Add New → Project** → import `jzps333/Buzzkill-PSU`.
2. Leave every setting as it is and click **Deploy**. `vercel.json` already tells Vercel the website is in `frontend/`.
3. Every push to `main` updates the site automatically.

## AI roasts (Gemini + ElevenLabs)

`supabase/functions/roast` is a Supabase Edge Function. When someone gets busted, the host page (or the Pi) asks it for a roast:
it reads the player's real stats, Gemini writes a savage (but clean) line, ElevenLabs turns it into an mp3.
Only the game's host or the Pi can call it, so nobody can burn the API credits.

Setup (once): Supabase → Edge Functions → deploy `roast` with **Verify JWT off**, then Edge Functions → Secrets:
`GEMINI_API_KEY` and `ELEVENLABS_API_KEY` (optional: `ELEVENLABS_VOICE_ID`, `GEMINI_MODEL`).
Without keys it still works and falls back to the built-in roasts.

## SOL bets (optional, test SOL only)

Players can bet test SOL (Solana **devnet**, not real money) in the lobby. **Last one standing takes the whole pot**:
betters with 0 pickups split it by bet size; if every better picked up, whoever picked up last wins it all.
Closed games, a lone better, players who left before the start, and late bets are refunded.

- Phone: lobby → **Bet with Phantom** → Phantom opens the `/stake` page → approve. (Phantom: Settings → Developer Settings → Testnet Mode → Solana Devnet. Free test SOL: faucet.solana.com.)
- `supabase/functions/sol` (Verify JWT off) checks payments on-chain and pays winners from the pot wallet. Its key is derived from the project's secret key, so there's nothing extra to set up.
- `backend/solana.sql`: `stakes` table + the payout rules in `finish_game` / `cancel_game`.
