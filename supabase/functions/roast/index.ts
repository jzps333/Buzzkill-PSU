// Buzzkill roast: Gemini writes a fresh insult from the player's real stats, ElevenLabs speaks it.
//
// POST /functions/v1/roast   body: { "game": "ABC123", "user_id": "<busted player's id>" }
// Who can call it (it costs API credits):
//   - the host of that game (website host page, sends their login token), or
//   - the Pi (sends the project's secret key in the "apikey" header)
// Returns: audio/mpeg (the roast) with the text in the "X-Roast-Text" header.
//          If ElevenLabs fails, returns JSON { text } so the caller can speak it another way.
//
// Secrets to set in Supabase -> Edge Functions -> Secrets:
//   GEMINI_API_KEY, ELEVENLABS_API_KEY            (required)
//   ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, GEMINI_MODEL   (optional)
// The Pi can also send { "say": "some text" } to get any short line in the same voice (startup, test).
// Deploy with "Verify JWT" OFF: the function checks callers itself, so the Pi's secret key works too.

import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://www.buzzkill.study", "https://buzzkill.study", "https://buzzkill-psu.vercel.app"];
const VOICE = Deno.env.get("ELEVENLABS_VOICE_ID") ?? "JBFqnCBsd6RMkjVDRZzb";      // "George"
// "-latest" names always point at Google's current model, so they don't break when old ones shut down
// Fastest first: Flash-Lite writes a 1-line roast in well under a second
// Fastest first: Flash-Lite writes a line in 1-2 seconds (the bigger Flash model took 13+ seconds)
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-3-flash-preview"]
  .filter(Boolean) as string[];

const FALLBACKS = [
  (n: string) => `${n}, the textbook just asked where you went.`,
  (n: string) => `And ${n} fumbles the focus! The crowd goes quiet.`,
  (n: string) => `${n}. I'm not mad. I'm just a little disappointed.`,
  (n: string) => `Breaking news: phone one, ${n} zero.`,
  (n: string) => `Here we see the wild ${n}, unable to resist the glowing rectangle.`,
  (n: string) => `Survey says: ${n} picked up the phone. Uh oh.`,
  (n: string) => `Ooooh, ${n}. Whatever it was, it could have waited.`,
  (n: string) => `${n}, your notes are feeling very ignored right now.`,
  (n: string) => `Ding ding ding! ${n} is our first contestant to crack.`,
  (n: string) => `Hold on, ${n}. Is the phone studying for you?`,
  (n: string) => `Tsk tsk, ${n}. So close to a clean game.`,
  (n: string) => `${n} has left the study session. Physically still here, though.`,
  (n: string) => `This just in: ${n}'s focus has been reported missing.`,
  (n: string) => `Yikes, ${n}. Everyone saw that.`,
  (n: string) => `${n}, put it down and nobody has to talk about this.`,
  (n: string) => `Wow, ${n}. Bold move picking it up right in front of the bee.`,
];

// The project's secret keys (new-style sb_secret_ keys come as JSON, plus the old service_role key)
function secretKeys(): string[] {
  const out: string[] = [];
  try { out.push(...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")) as string[]); } catch { /* none */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) out.push(legacy);
  return out.filter(Boolean);
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Roast-Text",
    "Vary": "Origin",
  };
}

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

// ---------- 1. Gemini writes the roast ----------
let problems: string[] = [];        // why the AI part failed (sent back to the host so we can fix it)

// A different voice every time: Buzz rotates through these characters so no two lines sound alike
const STYLES = [
  { who: "a dry, witty friend who teases with clever understatement",
    eg: ["Alex, the textbook misses you. It told me.", "Twelve minutes. A personal record for Alex. A low one, but a record."] },
  { who: "a hyped sports announcer calling the play-by-play",
    eg: ["And Alex reaches for the phone! A costly turnover at the twelve-minute mark!", "Sam pulls ahead while Alex fumbles the focus!"] },
  { who: "a gentle, disappointed parent (guilt, never anger)",
    eg: ["Alex. I'm not mad. I'm just disappointed.", "We talked about this, Alex. The phone can wait."] },
  { who: "a calm nature documentary narrator",
    eg: ["Here we observe the Alex in its natural habitat, reaching for the glowing rectangle once again.", "Fascinating. The Alex cannot resist the phone for even ten minutes."] },
  { who: "a breaking-news anchor",
    eg: ["Breaking news: phone wins again. Alex, zero.", "This just in: Alex's focus has been reported missing."] },
  { who: "a cheerful game show host",
    eg: ["Survey says: Alex picked up the phone! Better luck next round!", "Alex, come on down! You've won absolutely nothing."] },
];
const ANGLES = [
  "how quickly they gave in",
  "how they compare to someone else at the table (use a real name from the facts)",
  "their pickup count",
  "the studying they were supposed to be doing",
  "the rest of the table watching",
  "the phone itself (what could possibly be so important)",
  "how long they had lasted before this",
];
const SOUNDS = ["Hahaha", "Ooooh", "Yikes", "Oof", "Wow", "Ding ding ding", "Tsk tsk", "Uh oh"];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function writeRoast(facts: string, name: string, avoid: string[] = [], again = 0, seed = 0): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  const v3 = VOICES[0].model.includes("v3");
  const style = STYLES[(seed + again) % STYLES.length];      // a different voice for each line of the same pickup
  // Sound effects take turns too: every other line, never the same one twice in a row
  const sound = (seed + again) % 2 === 0 ? SOUNDS[(seed + again * 3) % SOUNDS.length] : null;
  const prompt = `You are Buzz, a funny bee who gently roasts college students out loud when they pick up their phone during a group study session. Everyone at the table hears it.

Write ONE brand-new line, 6 to 16 words, that uses their name. Short and punchy: one joke, then stop.
Don't read out statistics. Use at most one number, only if it makes the joke funnier, and say it naturally ("three times", "barely ten minutes").
Voice for this line: ${style.who}.
Focus on: ${pick(ANGLES)}.
Only sound like a news anchor if that is your voice for this line.
${again ? `They STILL haven't put the phone down (this is line ${again + 1} while they hold it). Comment on that.\n` : ""}${sound ? `Start or end with the sound "${sound}".` : "No sound effect this time."}
Keep it playful and clever, like teasing a friend. Nothing vulgar, no swearing, not over the top, never cruel.
Never mention race, gender, religion, sexuality, body, looks, health, money or family.
Plain spoken text only: no quotes, emojis, hashtags or stage directions.
${v3 ? `You may add one voice tag that changes HOW it's said (not read out): ${TAGS.map(t => `[${t}]`).join(" ")}\n` : ""}Examples of this voice (for the feel only, do not reuse them):
- ${style.eg.join("\n- ")}
${avoid.length ? `Lines already said this game. Use completely different jokes, words and structure:\n${avoid.map(a => "- " + a).join("\n")}\n` : ""}
Facts:
${facts}`;

  if (key) {
    for (const model of MODELS) {
      try {
        // Thinking makes Gemini slow (seconds). A one-line roast doesn't need it, so ask for as little as possible.
        const ask = (thinking: boolean) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 1.15, topP: 0.95, maxOutputTokens: 2048,   // room in case it thinks anyway
                                ...(thinking ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}) },
          }),
        });
        let r = await ask(true);
        if (r.status === 400) r = await ask(false);              // this model doesn't take that setting
        if (!r.ok) {                                           // model not available -> try the next one
          const why = `Gemini ${model}: ${r.status} ${(await r.text()).slice(0, 150)}`;
          console.log(why); problems.push(why);
          continue;
        }
        const data = await r.json();
        const text = (data?.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("")
          .replace(/["*#_`]/g, "").replace(/\s+/g, " ").trim();
        if (plain(text).length > 5) return text.slice(0, 300);
        problems.push(`Gemini ${model}: empty answer (${data?.candidates?.[0]?.finishReason ?? "?"})`);
      } catch (e) { problems.push(`Gemini ${model}: ${e}`); }
    }
  }
  if (!key) problems.push("GEMINI_API_KEY secret is missing");
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)](name);   // no key / Gemini down
}

// ---------- 2. ElevenLabs speaks it ----------
// Eleven v3 is the most human-sounding model: it acts out the [tags] (sighs, laughs, sarcasm).
// If v3 fails (not on your plan, busy), Flash v2.5 says it instead (fast, but flatter), with the tags removed.
const TAGS = ["sarcastic", "laughs", "chuckles", "sighs", "exasperated", "gasps", "mischievously", "whispers", "dramatically"];
const plain = (text: string) => text.replace(/\[[^\]]*(\]|$)/g, "").replace(/\s+/g, " ").trim();   // tags out (for display / Flash)
const onlyKnownTags = (text: string) =>
  text.replace(/\[[^\]]*$/, "").replace(/\[([^\]]*)\]/g, (m, t) => TAGS.includes(t.trim().toLowerCase()) ? `[${t.trim().toLowerCase()}]` : "").replace(/\s+/g, " ").trim();

// Default is Flash v2.5: made for speed (~0.1 s), so the roast lands right after the pickup.
// Want the slower, more dramatic voice that acts out [laughs]/[sighs]? Set the secret ELEVENLABS_MODEL = eleven_v3.
const FLASH = { model: "eleven_flash_v2_5", settings: { stability: 0.35, similarity_boost: 0.8, style: 0.4, use_speaker_boost: true } };
const VOICES = (Deno.env.get("ELEVENLABS_MODEL") ?? "").includes("v3")
  // v3 stability: 0 = Creative, 0.5 = Natural, 1 = Robust. Natural acts out the tags without going off script.
  ? [{ model: "eleven_v3", settings: { stability: 0.5, similarity_boost: 0.8 } }, FLASH]
  : [FLASH];

async function speak(text: string): Promise<ArrayBuffer | null> {
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) { problems.push("ELEVENLABS_API_KEY secret is missing"); return null; }
  for (const v of VOICES) {
    const line = v.model.includes("v3") ? onlyKnownTags(text) : plain(text);
    if (!plain(line)) { problems.push("Roast text was empty"); return null; }
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: line, model_id: v.model, voice_settings: v.settings }),
      });
      if (r.ok) return await r.arrayBuffer();
      const why = `ElevenLabs ${v.model}: ${r.status} ${(await r.text()).slice(0, 200)}`;
      console.log(why); problems.push(why);
    } catch (e) {
      problems.push(`ElevenLabs ${v.model}: ${e}`);
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  problems = [];
  const body = await req.json().catch(() => ({}));
  const secrets = secretKeys();
  const isPi = secrets.includes(req.headers.get("apikey") ?? "-");

  // ---------- The Pi's own lines ("Buzzkill speaker ready"), in the same voice ----------
  if (typeof body.say === "string") {
    if (!isPi) return json(req, { error: "Only the brick can do this" }, 403);
    const text = body.say.slice(0, 200);
    const audio = await speak(text);
    if (!audio) return json(req, { text: plain(text) });
    return new Response(audio, { headers: { ...cors(req), "Content-Type": "audio/mpeg", "X-Roast-Text": encodeURIComponent(plain(text)) } });
  }

  const game = String(body.game ?? "").toUpperCase();
  const userId = String(body.user_id ?? "");
  if (!/^[A-Z0-9]{4,12}$/.test(game) || !/^[0-9a-f-]{36}$/.test(userId)) return json(req, { error: "Bad request" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, secrets[0] ?? "", { auth: { persistSession: false } });

  // ---------- 3. Who's asking? The Pi (secret key) or the game's host (login token) ----------
  const { data: g } = await admin.from("games").select("code, status, mode, host_id, start_time").eq("code", game).maybeSingle();
  if (!g) return json(req, { error: "No such game" }, 404);

  if (!isPi) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = token ? await admin.auth.getUser(token) : { data: { user: null } };
    if (!u?.user || u.user.id !== g.host_id) return json(req, { error: "Only the host or the brick can ask for roasts" }, 403);
  }

  // ---------- 4. The facts Gemini gets ----------
  const { data: rows } = await admin.from("results")
    .select("user_id, pickups, team, alarm_cause, profiles(username)").eq("game", game);
  const players = (rows ?? []) as unknown as Array<{ user_id: string; pickups: number; team: number | null; alarm_cause: string | null; profiles: { username: string } | null }>;
  const nameOf = (id: string | null) => players.find(p => p.user_id === id)?.profiles?.username ?? "someone";
  const target = players.find(p => p.user_id === userId);
  if (!target) return json(req, { error: "Player not in this game" }, 404);

  const name = nameOf(userId);
  const { data: gEnd } = await admin.from("games").select("end_time").eq("code", game).maybeSingle();
  const until = gEnd?.end_time ? new Date(gEnd.end_time).getTime() : Date.now();
  const minutes = g.start_time ? Math.max(1, Math.round((until - new Date(g.start_time).getTime()) / 60000)) : 1;
  const others = players.filter(p => p.user_id !== userId)
    .map(p => `${p.profiles?.username ?? "someone"}: ${p.pickups} pickups`).join(", ");
  let facts = `- ${name} just got caught. This is pickup number ${target.pickups} for them.\n` +
              `- ${minutes} minutes into the study session.\n- Everyone else: ${others || "nobody else yet"}.`;
  if (g.mode === "teams" && target.team) {
    const team = (t: number) => players.filter(p => p.team === t).reduce((s, p) => s + p.pickups, 0);
    const mine = target.team, theirs = mine === 1 ? 2 : 1;
    facts += `\n- Teams game. ${name} is on Team ${mine === 1 ? "Honey" : "Stingers"} (${team(mine)} pickups) vs Team ${theirs === 1 ? "Honey" : "Stingers"} (${team(theirs)}).`;
    if (target.alarm_cause && target.alarm_cause !== userId) {
      facts += `\n- ${name} did NOT pick up. Their teammate ${nameOf(target.alarm_cause)} did, so the whole team is being punished. Roast ${nameOf(target.alarm_cause)} for dragging ${name} down.`;
    }
  }

  // ---------- 5. Write it, speak it ----------
  const avoid = Array.isArray(body.avoid) ? body.avoid.filter((a: unknown) => typeof a === "string").slice(-10).map((a: string) => a.slice(0, 200)) : [];
  const again = Math.max(0, Math.min(20, Number(body.again) || 0));   // how many lines they've already heard for this pickup
  // Start each pickup on a random voice, then step through the others
  const seed = [...(game + userId + target.pickups)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const text = await writeRoast(facts, name, avoid, again, seed);
  const audio = await speak(text);
  if (!audio) return json(req, { text: plain(text), problems });   // no voice: caller reads the text itself

  return new Response(audio, {
    headers: { ...cors(req), "Content-Type": "audio/mpeg", "X-Roast-Text": encodeURIComponent(plain(text)), "Cache-Control": "no-store" },
  });
});
