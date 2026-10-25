# Buzzkill-hackathon-PSU
This project is for the Fall26 hackathon this project is a study app that calls you names if you pick up your phone and o turn it off you have to shake it!


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
