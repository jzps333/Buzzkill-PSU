# Backend (Supabase)

Supabase handles logins and the database. There's no server code to run for this part.

## Setup (once)

1. Make a project at supabase.com.
2. **SQL Editor** → paste all of `schema.sql` → **Run**.
3. **Authentication → Sign In / Providers**:
   - Turn **on** "Allow anonymous sign-ins" (this is how guests work).
   - Turn **off** "Confirm email" (so signups work instantly at the hackathon).
4. **Project Settings → API** → copy the URL and the **anon** key into `frontend/config.js`.

## Tables

| Table | What it holds |
|---|---|
| `profiles` | One row per user: username, guest or not, Solana wallet |
| `games` | One row per study session: room code, status, start/end time |
| `results` | One row per person per game: pickups, SOL in, SOL back |
| `leaderboard` (view) | Stats calculated from `results`, most focused first |

## Stats

- **SOL per game** = `sol_back - sol_in`
- **avg_sol** = average of that, only counting games they staked in
- **pickups_per_hour** = total pickups ÷ hours played. Lower = more focused. This is the ranking.
- **clean_pct** = % of games with 0 pickups (tiebreaker)

## For the Pi / game code

The Pi writes to `games` and `results` using the **service_role (secret) key**.
Keep that key on the Pi only. Never put it in the website or in git.

```python
from datetime import datetime, timezone
from supabase import create_client          # pip install supabase
sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# New game
sb.table("games").insert({"code": "ABC123"}).execute()

# Player joins (user_id comes from their login)
sb.table("results").insert({"game": "ABC123", "user_id": user_id}).execute()

# Game starts / ends
sb.table("games").update({"status": "live", "start_time": datetime.now(timezone.utc).isoformat()}).eq("code", "ABC123").execute()
sb.table("games").update({"status": "ended", "end_time": datetime.now(timezone.utc).isoformat()}).eq("code", "ABC123").execute()

# Pickup (+1)
row = sb.table("results").select("pickups").eq("game", "ABC123").eq("user_id", user_id).single().execute()
sb.table("results").update({"pickups": row.data["pickups"] + 1}).eq("game", "ABC123").eq("user_id", user_id).execute()

# Payout at the end
sb.table("results").update({"sol_back": 0.14}).eq("game", "ABC123").eq("user_id", user_id).execute()
```

To know who a phone belongs to, the phone sends its login token, and the Pi checks it:

```python
user = sb.auth.get_user(token).user   # token from the phone: (await sb.auth.getSession()).data.session.access_token
user_id = user.id
```
