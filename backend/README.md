# Backend (Supabase)

Supabase handles logins and the database. There's no server code to run for this part.

## Setup (once)

1. Make a project at supabase.com.
2. **SQL Editor** → paste all of `schema.sql` → **Run**. Then do the same, in order, with `events.sql`, `security.sql`, `game.sql`, `shake_ramp.sql`, `friends.sql`, `phone_only.sql`. (All are already done for the buzzkill project.)
3. **Authentication → Sign In / Providers**:
   - Turn **on** "Allow anonymous sign-ins" (this is how guests work).
   - Turn **off** "Confirm email" (so signups work instantly at the hackathon).
4. **Authentication → URL Configuration**: Site URL = `https://www.buzzkill.study`. Redirect URLs = `https://www.buzzkill.study/**`, `https://buzzkill.study/**`, `https://buzzkill-psu.vercel.app/**`.
5. **Google login**: see "Google sign-in" below.
6. **Project Settings → API** → copy the URL and the **anon** key into `frontend/config.js`.

## Tables

| Table | What it holds |
|---|---|
| `profiles` | One row per user: username, guest or not, Solana wallet |
| `games` | One row per study session: room code, status, start/end time |
| `results` | One row per person per game: pickups, SOL in, SOL back |
| `events` | Every join, pickup and shake from a phone. The Pi listens to it live. |
| `leaderboard` (view) | Stats calculated from `results`, most focused first |
| `game_awards` (view) | Titles per game: Iron Will, Doomscroller, First to Fold |
| `friendships` | Friend requests and friends (pending / accepted). Use `send_friend_request(username)` and `accept_friend_request(id)` |
| `rivalries` (view) | Your wins/losses vs. every other player. Nemesis = most losses |

## Stats

- **SOL per game** = `sol_back - sol_in`
- **avg_sol** = average of that, only counting games they staked in
- **pickups_per_hour** = total pickups ÷ hours played. Lower = more focused. This is the ranking.
- **clean_pct** = % of games with 0 pickups (tiebreaker)

## Game rules (game.sql)

The database is the referee. Phones only send events; a trigger does the rest:

- `join` (game waiting) → adds the player to `results`
- `pickup` / `left_page` (game live) → +1 pickup, `alarm_on = true`, shaking needed: 10s, 30s, 1 min, then +30s each pickup after (`shake_ramp.sql`)
- `shake` → phones send this ~2×/second while shaking; it adds up shaking time and sets `is_shaking = true` (sound paused). Enough time = alarm off
- `shake_stop` → phone stopped shaking early: `is_shaking = false`, sound comes back
- `create_game()`, `start_game(code)`, `finish_game(code)` run games. `start_game` refuses to start with fewer than 4 players, for everyone. Only the Pi (secret key) or the person who created the game can call them. `finish_game` also calculates payouts.

See `hardware/README.md` for what the Pi does.

**Nemesis query** (for the profile page):
```js
sb.from("rivalries").select("*").eq("user_id", myId).gt("losses", 0)
  .order("losses", { ascending: false }).limit(1)
```

## Phone-only joining (phone_only.sql)

You can only join a game from a phone (iPhone or Android phone). Laptops, iPads and tablets are blocked in 3 places:
the PIN box, the join page (which also checks for a real motion sensor before joining), and the database.

## Google sign-in

1. Go to console.cloud.google.com → make a project → **APIs & Services → OAuth consent screen** → External → fill in app name and your email.
2. **Credentials → Create credentials → OAuth client ID** → Web application.
   - Authorized JavaScript origins: `https://www.buzzkill.study` and `https://buzzkill.study`
   - Authorized redirect URI: `https://qlfqgyrwrihwomadqjsh.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret**.
4. Supabase → **Authentication → Sign In / Providers → Google** → turn on → paste both → Save.

## Security rules (security.sql)

- Players can only change their own username and wallet. Nobody can edit pickups, SOL, or games except the Pi.
- Phones can only send events as themselves, for an open game. Nobody can read other people's events.
- Usernames: max 30 characters. Wallets must look like real Solana addresses.
- The website escapes usernames before showing them, so nobody can sneak code in through their name.
- `vercel.json` adds browser security headers (blocks other sites from embedding ours, limits where the page can connect).
