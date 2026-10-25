/*
  Player stats and site records, worked out from every finished game (results + games, both public).
  Guests are left out, like on the leaderboard. Used by leaderboard.html and dashboard.html.

    const { players, records } = await BuzzStats.load();
    players.get(userId) -> { name, games, wins, winRate, minutes, pickups, clean, cleanStreak, bestCleanStreak,
                             longestFocus, fastestFold, mostPlayedWith, mostWonAgainst, nemesis }
    BuzzStats.time(seconds) -> "1h 12m" / "25m" / "1m 30s" / "48s"

  Focus = time without touching your phone: the stretches between the start of a game, each pickup
  (results.pickup_times) and the end. Older games only saved the first pickup, so for those we use
  start -> first pickup (a clean game counts in full).
    longestFocus = your longest stretch    fastestFold = the shortest time from the start of a game to a first pickup
  A win = fewest pickups in a game with 2+ players (ties all count as wins).
*/
window.BuzzStats = (() => {
  function time(s) {
    if (s == null || !isFinite(s)) return "–";
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s}s`;
    if (s < 600 && s % 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  async function load() {
    const { data, error } = await sb.from("results")
      .select("game, user_id, pickups, first_pickup_at, pickup_times, games!inner(start_time, end_time, status), profiles!inner(username, is_guest)")
      .eq("games.status", "ended").eq("profiles.is_guest", false)
      .limit(20000);
    if (error) throw error;

    // Games, oldest first
    const games = new Map();
    for (const r of data || []) {
      const g = r.games;
      if (!g.start_time || !g.end_time) continue;
      if (!games.has(r.game)) games.set(r.game, { start: new Date(g.start_time), end: new Date(g.end_time), rows: [] });
      games.get(r.game).rows.push(r);
    }
    const ordered = [...games.values()].sort((a, b) => a.end - b.end);

    const players = new Map();
    const pairs = new Map();            // "a|b" (a < b) -> { a, b, games, aWins, bWins }
    const P = (id, name) => {
      if (!players.has(id)) players.set(id, {
        id, name, games: 0, wins: 0, minutes: 0, pickups: 0, clean: 0, cleanStreak: 0, bestCleanStreak: 0,
        longestFocus: null, fastestFold: null, with: new Map(), beat: new Map(), lostTo: new Map(),
      });
      return players.get(id);
    };

    for (const g of ordered) {
      const dur = (g.end - g.start) / 1000;
      const fewest = Math.min(...g.rows.map(r => r.pickups));
      for (const r of g.rows) {
        const p = P(r.user_id, r.profiles.username);
        p.games++;
        p.minutes += dur / 60;
        p.pickups += r.pickups;
        if (g.rows.length > 1 && r.pickups === fewest) p.wins++;
        if (r.pickups === 0) { p.clean++; p.cleanStreak++; p.bestCleanStreak = Math.max(p.bestCleanStreak, p.cleanStreak); }
        else p.cleanStreak = 0;
        const times = (r.pickup_times || []).map(t => new Date(t).getTime()).sort((a, b) => a - b);
        let stretches;
        if (r.pickups === 0) stretches = [dur];
        else if (times.length === r.pickups) {
          const marks = [g.start.getTime(), ...times, g.end.getTime()];
          stretches = marks.slice(1).map((m, i) => (m - marks[i]) / 1000);
        } else if (r.first_pickup_at) stretches = [(new Date(r.first_pickup_at) - g.start) / 1000];   // older games
        else stretches = [];
        for (const f of stretches) if (f >= 0) p.longestFocus = Math.max(p.longestFocus ?? 0, f);
        const first = times.length ? times[0] : r.first_pickup_at ? new Date(r.first_pickup_at).getTime() : null;
        if (r.pickups > 0 && first) {
          const fold = (first - g.start) / 1000;
          if (fold >= 0) p.fastestFold = Math.min(p.fastestFold ?? Infinity, fold);
        }
        for (const o of g.rows) {
          if (o.user_id === r.user_id) continue;
          p.with.set(o.user_id, (p.with.get(o.user_id) || 0) + 1);
          if (r.pickups < o.pickups) p.beat.set(o.user_id, (p.beat.get(o.user_id) || 0) + 1);
          if (r.pickups > o.pickups) p.lostTo.set(o.user_id, (p.lostTo.get(o.user_id) || 0) + 1);
          if (r.user_id < o.user_id) {
            const k = r.user_id + "|" + o.user_id;
            if (!pairs.has(k)) pairs.set(k, { a: r.user_id, b: o.user_id, games: 0, aWins: 0, bWins: 0 });
            const pr = pairs.get(k);
            pr.games++;
            if (r.pickups < o.pickups) pr.aWins++;
            if (r.pickups > o.pickups) pr.bWins++;
          }
        }
      }
    }

    const top = m => { let best = null; for (const [id, n] of m) if (!best || n > best.n) best = { id, n }; return best; };
    for (const p of players.values()) {
      p.winRate = p.games ? p.wins / p.games : 0;
      const w = top(p.with), b = top(p.beat), l = top(p.lostTo);
      p.mostPlayedWith = w && { name: players.get(w.id)?.name, n: w.n };
      p.mostWonAgainst = b && { name: players.get(b.id)?.name, n: b.n };
      p.nemesis = l && l.n >= 2 ? { name: players.get(l.id)?.name, n: l.n, wins: p.beat.get(l.id) || 0 } : null;
    }

    // Site records
    const list = [...players.values()];
    const best = (arr, score) => arr.reduce((a, b) => (score(b) > score(a) ? b : a), arr[0]);
    const records = [];
    if (list.length) {
      // Ties (e.g. everyone with a clean game has the same longest focus) go to the more consistent player
      const lf = best(list.filter(p => p.longestFocus != null), p => p.longestFocus + p.clean / 1e3);
      if (lf) records.push({ icon: "🧘", title: "Longest focus", who: lf.name, value: time(lf.longestFocus), note: "without touching their phone" });
      const ff = best(list.filter(p => p.fastestFold != null), p => -p.fastestFold + p.pickups / 1e3);
      if (ff) records.push({ icon: "🫠", title: "Fastest fold", who: ff.name, value: time(ff.fastestFold), note: "start of a game to first pickup" });
      const mg = best(list, p => p.games + p.minutes / 1e6);
      records.push({ icon: "🎮", title: "Most games", who: mg.name, value: String(mg.games), note: "finished games played" });
      const wr = best(list.filter(p => p.games >= 3), p => p.winRate + p.games / 1e4);
      if (wr) records.push({ icon: "🏆", title: "Best win rate", who: wr.name, value: `${Math.round(wr.winRate * 100)}%`, note: `${wr.wins} of ${wr.games} games (3+ games)` });
      const cs = best(list, p => p.bestCleanStreak + p.clean / 1e3);
      if (cs.bestCleanStreak > 0) records.push({ icon: "🔥", title: "Longest clean streak", who: cs.name, value: `${cs.bestCleanStreak} games`, note: "in a row with zero pickups" });
      const mm = best(list, p => p.minutes);
      records.push({ icon: "⏱️", title: "Most time studied", who: mm.name, value: time(mm.minutes * 60), note: "across finished games" });
    }
    const pl = [...pairs.values()];
    if (pl.length) {
      const dup = best(pl, x => x.games);
      records.push({ icon: "🤝", title: "Study buddies", who: `${players.get(dup.a).name} & ${players.get(dup.b).name}`, value: `${dup.games} games`, note: "most games played together" });
      const one = best(pl.filter(x => x.games >= 3), x => Math.abs(x.aWins - x.bWins));
      if (one && one.aWins !== one.bWins) {
        const [w, l, wn, ln] = one.aWins > one.bWins ? [one.a, one.b, one.aWins, one.bWins] : [one.b, one.a, one.bWins, one.aWins];
        records.push({ icon: "👑", title: "Most one-sided rivalry", who: `${players.get(w).name} over ${players.get(l).name}`, value: `${wn}–${ln}`, note: "head to head, 3+ games" });
      }
    }
    return { players, records };
  }

  return { load, time };
})();
