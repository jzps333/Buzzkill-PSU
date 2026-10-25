-- Buzzkill: optional SOL bets (run after shake_grace.sql). Test SOL only (Solana devnet).
--
-- HOW IT WORKS
--   - In the lobby, any player can bet any amount of SOL (optional). They send it with Phantom to the pot wallet.
--   - The "sol" Edge Function checks the payment on the blockchain and marks the stake as "in".
--   - LAST ONE STANDING TAKES ALL: when the game ends, the whole pot goes to the betters who never picked up
--     (split by how much each one bet). If every better picked up, the one who held out longest wins it all.
--   - Refunds: game closed before it starts, fewer than 2 betters, left before the game started, or a bet that
--     arrived after the game started.
--   - Only the Edge Function (secret key) can write stakes. Players can only read them.


-- 1. STAKES: one row per bet
create table public.stakes (
  id         bigint generated always as identity primary key,
  game       text not null references public.games (code) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  reference  text not null unique,                 -- random key put in the payment so we can find it on-chain
  amount     numeric,                              -- SOL actually received (set when confirmed)
  wallet     text,                                 -- who paid (winnings / refunds go back here)
  tx         text unique,                          -- the payment's transaction id
  status     text not null default 'pending'
             check (status in ('pending', 'in', 'sending', 'paid', 'lost', 'failed')),
  payout     numeric,                              -- SOL to send back at the end (0 = lost it)
  payout_tx  text,
  created_at timestamptz not null default now()
);
create index stakes_game on public.stakes (game);

alter table public.stakes enable row level security;
create policy "anyone logged in can see bets" on public.stakes for select to authenticated using (true);
revoke insert, update, delete on public.stakes from anon, authenticated;
grant select on public.stakes to authenticated;

alter publication supabase_realtime add table public.stakes;


-- 2. END A GAME: last one standing takes the whole pot
create or replace function public.finish_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  betters     int;
  pot         numeric;
  winners_bet numeric;
begin
  if not public.can_host(p_code) then raise exception 'Only the host can end this game'; end if;

  update public.games set status = 'ended', end_time = now()
  where code = p_code and status = 'live';
  if not found then return; end if;

  update public.results set alarm_on = false, is_shaking = false where game = p_code;

  -- Each player's bet (only players still in the game)
  update public.results r set sol_in = s.total, sol_back = 0
  from (select user_id, sum(amount) as total from public.stakes
        where game = p_code and status = 'in' group by user_id) s
  where r.game = p_code and r.user_id = s.user_id;

  select count(*), coalesce(sum(sol_in), 0) into betters, pot
  from public.results where game = p_code and sol_in > 0;

  if betters >= 2 then
    -- Winners: betters with 0 pickups. If there are none, the better who picked up LAST.
    update public.results set sol_back = -1        -- -1 marks a winner for a moment
    where game = p_code and sol_in > 0 and pickups = 0;
    if not found then
      update public.results set sol_back = -1
      where game = p_code and sol_in > 0 and first_pickup_at = (
        select max(first_pickup_at) from public.results where game = p_code and sol_in > 0);
    end if;

    select sum(sol_in) into winners_bet from public.results where game = p_code and sol_back = -1;
    update public.results set sol_back = case
        when sol_back = -1 then round(pot * sol_in / winners_bet, 9)   -- winners split the pot by bet size
        else 0 end                                                     -- everyone else loses their bet
    where game = p_code and sol_in > 0;
  else
    update public.results set sol_back = sol_in where game = p_code and sol_in > 0;   -- 1 better: refund
  end if;

  -- What each bet gets back. Bets from players who left (no results row) are refunded.
  update public.stakes s set payout = coalesce(
      (select round(r.sol_back * s.amount / r.sol_in, 9) from public.results r
       where r.game = s.game and r.user_id = s.user_id and r.sol_in > 0),
      s.amount)
  where s.game = p_code and s.status = 'in';
end;
$$;


-- 3. CLOSE A GAME before it starts: every bet is refunded
create or replace function public.cancel_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_host(p_code) then raise exception 'Only the host can close this game'; end if;
  update public.games set status = 'cancelled', end_time = now()
  where code = p_code and status = 'waiting';
  if not found then raise exception 'Only a game that has not started yet can be closed. End a live game instead.'; end if;
  update public.stakes set payout = amount where game = p_code and status = 'in';
end;
$$;

revoke all on function public.finish_game(text), public.cancel_game(text) from public, anon;
grant execute on function public.finish_game(text), public.cancel_game(text) to authenticated, service_role;
