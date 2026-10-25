// Buzzkill SOL bets (Solana DEVNET = test SOL only, no real money).
//
// POST /functions/v1/sol   body: { "action": ..., "game": "ABC123", ... }
//   "pot"     -> { pot }                                    the pot wallet's address (anyone)
//   "start"   -> { pot, reference }                         a player starts a bet (logged in, in the lobby)
//   "check"   -> { status, amount }                         a player asks "did my payment arrive?"
//   "payout"  -> { paid, lost, failed }                     after the game ends/closes: send winnings + refunds
//                                                           (the game's host or the Pi)
//
// The pot wallet's key is made from the project's secret key, so there's no extra secret to set up.
// It only ever touches devnet. Deploy with "Verify JWT" OFF (the function checks callers itself).

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "npm:@solana/web3.js@1.98.0";

const RPC = "https://api.devnet.solana.com";
const ALLOWED_ORIGINS = ["https://www.buzzkill.study", "https://buzzkill.study", "https://buzzkill-psu.vercel.app"];
const MIN_BET = 0.001;

function secretKeys(): string[] {
  const out: string[] = [];
  try { out.push(...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")) as string[]); } catch { /* none */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) out.push(legacy);
  return out.filter(Boolean);
}

// Pot wallet: the same key every time, made from a secret only this server knows
async function potWallet(): Promise<Keypair> {
  const base = Deno.env.get("SOL_POT_SEED") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? secretKeys()[0];
  const seed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("buzzkill-devnet-pot:" + base));
  return Keypair.fromSeed(new Uint8Array(seed));
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

// Pay fees from the pot: on devnet, top it up for free if it runs low
async function keepFeesTopped(conn: Connection, pot: PublicKey) {
  try {
    if (await conn.getBalance(pot) < 0.05 * LAMPORTS_PER_SOL) await conn.requestAirdrop(pot, LAMPORTS_PER_SOL);
  } catch { /* faucet busy: fine */ }
}

// Look for the player's payment on-chain (found by the random reference key inside it)
async function findPayment(conn: Connection, pot: PublicKey, reference: string) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(reference), { limit: 10 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || tx.meta?.err) continue;
    for (const ix of tx.transaction.message.instructions) {
      // deno-lint-ignore no-explicit-any
      const p = (ix as any).parsed;
      if (ix.programId.equals(SystemProgram.programId) && p?.type === "transfer" && p.info.destination === pot.toBase58()) {
        return { tx: s.signature, wallet: p.info.source as string, amount: p.info.lamports / LAMPORTS_PER_SOL, time: s.blockTime ?? null };
      }
    }
  }
  return null;
}

// The network fee (5000 lamports = 0.000005 SOL) comes out of each payout, so the pot never runs dry
const FEE = 5000;
async function send(conn: Connection, potKey: Keypair, to: string, sol: number): Promise<string> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL) - FEE;
  if (lamports <= 0) throw new Error("Too small to send");
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: potKey.publicKey, toPubkey: new PublicKey(to), lamports,
  }));
  return await sendAndConfirmTransaction(conn, tx, [potKey], { commitment: "confirmed" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const potKey = await potWallet();
  const pot = potKey.publicKey;
  if (action === "pot") return json(req, { pot: pot.toBase58(), network: "devnet" });

  const game = String(body.game ?? "").toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(game)) return json(req, { error: "Bad game code" }, 400);

  const secrets = secretKeys();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, secrets[0] ?? "", { auth: { persistSession: false } });
  const conn = new Connection(RPC, "confirmed");

  // Who's asking?
  const isPi = secrets.includes(req.headers.get("apikey") ?? "-");
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = token && !isPi ? await admin.auth.getUser(token) : { data: { user: null } };
  const me = u?.user?.id ?? null;

  const { data: g } = await admin.from("games").select("code, status, host_id, start_time").eq("code", game).maybeSingle();
  if (!g) return json(req, { error: "No such game" }, 404);

  // ---------- START: a player wants to bet ----------
  if (action === "start") {
    if (!me) return json(req, { error: "Log in first" }, 401);
    if (g.status !== "waiting") return json(req, { error: "Bets close when the game starts" }, 400);
    const { data: inGame } = await admin.from("results").select("user_id").eq("game", game).eq("user_id", me).maybeSingle();
    if (!inGame) return json(req, { error: "Join the game first" }, 400);
    const { data: done } = await admin.from("stakes").select("id").eq("game", game).eq("user_id", me).neq("status", "pending").limit(1);
    if (done?.length) return json(req, { error: "You already bet in this game" }, 400);

    await keepFeesTopped(conn, pot);
    await admin.from("stakes").delete().eq("game", game).eq("user_id", me).eq("status", "pending");   // drop unfinished tries
    const reference = Keypair.generate().publicKey.toBase58();
    const { error } = await admin.from("stakes").insert({ game, user_id: me, reference });
    if (error) return json(req, { error: error.message }, 500);
    return json(req, { pot: pot.toBase58(), reference });
  }

  // ---------- CHECK: did the player's payment arrive? ----------
  if (action === "check") {
    if (!me) return json(req, { error: "Log in first" }, 401);
    const { data: st } = await admin.from("stakes").select("*").eq("game", game).eq("user_id", me)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    if (!st) return json(req, { status: "none" });
    if (st.status !== "pending") return json(req, { status: st.status, amount: st.amount });

    const paid = await findPayment(conn, pot, st.reference).catch(() => null);
    if (!paid) return json(req, { status: "pending" });
    if (paid.amount < MIN_BET) return json(req, { status: "pending", error: "Too small" });

    // Arrived after the game started? Not allowed: send it straight back.
    const late = g.status !== "waiting" && !(paid.time && g.start_time && paid.time * 1000 <= new Date(g.start_time).getTime());
    const { error } = await admin.from("stakes").update({
      status: "in", amount: paid.amount, wallet: paid.wallet, tx: paid.tx, payout: late ? paid.amount : null,
    }).eq("id", st.id).eq("status", "pending");
    if (error) return json(req, { status: "pending", error: "That payment was already used" });
    if (late) {
      try {
        const sig = await send(conn, potKey, paid.wallet, paid.amount);
        await admin.from("stakes").update({ status: "paid", payout_tx: sig }).eq("id", st.id);
      } catch { /* the end-of-game payout will retry it */ }
      return json(req, { status: "refunded", amount: paid.amount, error: "The game had already started, so it was sent back" });
    }
    return json(req, { status: "in", amount: paid.amount });
  }

  // ---------- PAYOUT: send winnings and refunds (game over or closed) ----------
  if (action === "payout") {
    if (!isPi && me !== g.host_id) return json(req, { error: "Only the host or the brick can pay out" }, 403);
    if (!["ended", "cancelled"].includes(g.status)) return json(req, { error: "The game is still going" }, 400);

    // Grab the unpaid ones (so two payouts at once can't pay twice)
    const { data: due } = await admin.from("stakes").update({ status: "sending" })
      .eq("game", game).in("status", ["in", "failed"]).not("payout", "is", null).select("*");
    let paidCount = 0, lost = 0, failed = 0;
    for (const s of due ?? []) {
      if (Number(s.payout) <= 0) {
        await admin.from("stakes").update({ status: "lost" }).eq("id", s.id);
        lost++;
        continue;
      }
      try {
        const sig = await send(conn, potKey, s.wallet, Number(s.payout));
        await admin.from("stakes").update({ status: "paid", payout_tx: sig }).eq("id", s.id);
        paidCount++;
      } catch (e) {
        console.log("payout failed", s.id, String(e));
        await admin.from("stakes").update({ status: "failed" }).eq("id", s.id);   // try again later
        failed++;
      }
    }
    return json(req, { paid: paidCount, lost, failed });
  }

  return json(req, { error: "Unknown action" }, 400);
});
