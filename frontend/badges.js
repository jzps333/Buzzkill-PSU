/*
  Badges: 3D medals made with three.js, worked out from your finished games.
  Add to a page:  <div id="badges"></div>  and  <script type="module" src="badges.js"></script>

  Regular badges show what they're for (grey until you earn them).
  Mystery badges are a "?" until you earn one by accident. Then you find out what it was.
  Each medal is drawn once into a picture (so 18 medals only use one 3D canvas).
  Tap a medal to see it big and spin it.
*/
import * as THREE from "./vendor/three.module.min.js";

// ---------- 1. The badges ----------
// check(s) gets your stats (see collect()) and returns [current, goal]. Earned when current >= goal.
export const BADGES = [
  { id: "first",    icon: "🐝", name: "First Buzz",     desc: "Finish your first game.",                         check: s => [s.games, 1] },
  { id: "clean",    icon: "✨", name: "Clean Sheet",    desc: "Finish a game with 0 pickups.",                   check: s => [s.cleanGames ? 1 : 0, 1] },
  { id: "hattrick", icon: "🎩", name: "Hat Trick",      desc: "3 clean games in a row.",                         check: s => [s.bestCleanRun, 3] },
  { id: "iron",     icon: "🛡️", name: "Iron Will",      desc: "5 clean games in total.",                         check: s => [s.cleanGames, 5] },
  { id: "hour",     icon: "⏳", name: "Hour of Power",  desc: "Go 60 minutes without touching your phone.",      check: s => [Math.floor(s.longest / 60), 60], unit: "min" },
  { id: "regular",  icon: "📅", name: "Regular",        desc: "Play 10 games.",                                  check: s => [s.games, 10] },
  { id: "marathon", icon: "🏃", name: "Marathon",       desc: "Study 10 hours in Buzzkill games.",               check: s => [Math.floor(s.seconds / 3600), 10], unit: "h" },
  { id: "crown",    icon: "👑", name: "Top of the Hive", desc: "Fewest pickups (no ties) in a game of 4+.",      check: s => [s.outrightWins ? 1 : 0, 1] },
  { id: "team",     icon: "🤝", name: "Team Player",    desc: "Win a teams game.",                               check: s => [s.teamWins ? 1 : 0, 1] },
  { id: "social",   icon: "🦋", name: "Social Bee",     desc: "Have 3 friends.",                                 check: s => [s.friends, 3] },

  { id: "comeback", icon: "🔄", name: "Comeback Kid",   desc: "Picked up first, and still won the game.",        check: s => [s.comeback ? 1 : 0, 1], mystery: true },
  { id: "owl",      icon: "🦉", name: "Night Owl",      desc: "Finished a game between midnight and 4 a.m.",     check: s => [s.nightOwl ? 1 : 0, 1], mystery: true },
  { id: "bird",     icon: "🌅", name: "Early Bird",     desc: "Started a game before 8 a.m.",                    check: s => [s.earlyBird ? 1 : 0, 1], mystery: true },
  { id: "diamond",  icon: "💎", name: "Untouchable",    desc: "A clean game that lasted 90+ minutes.",           check: s => [s.untouchable ? 1 : 0, 1], mystery: true },
  { id: "panic",    icon: "🆘", name: "Panic Button",   desc: "Used your emergency pass.",                       check: s => [s.usedPass ? 1 : 0, 1], mystery: true },
  { id: "butter",   icon: "🧈", name: "Butterfingers",  desc: "5 or more pickups in one game. Oops.",            check: s => [s.butterfingers ? 1 : 0, 1], mystery: true },
  { id: "revenge",  icon: "⚔️", name: "Revenge",        desc: "Beat someone right after they beat you.",         check: s => [s.revenge ? 1 : 0, 1], mystery: true },
  { id: "photo",    icon: "📸", name: "Photo Finish",   desc: "Won a game by exactly one pickup.",               check: s => [s.photoFinish ? 1 : 0, 1], mystery: true },
];

// ---------- 2. Stats for the badges, from your finished games ----------
export function collect(mine, all, friends) {
  const s = { games: mine.length, cleanGames: 0, bestCleanRun: 0, longest: 0, seconds: 0, outrightWins: 0, teamWins: 0, friends,
              comeback: false, nightOwl: false, earlyBird: false, untouchable: false, usedPass: false, butterfingers: false, revenge: false, photoFinish: false };
  mine.sort((a, b) => new Date(a.games.end_time) - new Date(b.games.end_time));
  const byGame = {};
  for (const r of all) (byGame[r.game] ??= []).push(r);

  let run = 0;
  const lastVs = {};                                  // opponent -> did they beat me last time we played?
  for (const g of mine) {
    const start = new Date(g.games.start_time), end = new Date(g.games.end_time), secs = (end - start) / 1000;
    const others = (byGame[g.game] || []).filter(o => o.user_id !== g.user_id);
    s.seconds += secs;
    if (g.pickups === 0) { s.cleanGames++; run++; if (secs >= 90 * 60) s.untouchable = true; } else run = 0;
    s.bestCleanRun = Math.max(s.bestCleanRun, run);
    if (g.pickups >= 5) s.butterfingers = true;
    if (g.pass_used) s.usedPass = true;
    if (end.getHours() < 4) s.nightOwl = true;
    if (start.getHours() >= 4 && start.getHours() < 8) s.earlyBird = true;

    // Longest focus stretch (only games that saved pickup times)
    const times = (g.pickup_times || []).map(t => +new Date(t)).sort((a, b) => a - b);
    if (times.length === g.pickups) {
      const marks = [+start, ...times, +end];
      for (let i = 1; i < marks.length; i++) s.longest = Math.max(s.longest, (marks[i] - marks[i - 1]) / 1000);
    }

    // Winning: strictly fewer pickups than everyone else
    const otherMin = others.length ? Math.min(...others.map(o => o.pickups)) : Infinity;
    const won = others.length > 0 && g.pickups < otherMin;
    if (won && others.length >= 3) s.outrightWins++;
    if (won && otherMin === g.pickups + 1) s.photoFinish = true;
    if (won && g.first_pickup_at && others.every(o => !o.first_pickup_at || new Date(o.first_pickup_at) > new Date(g.first_pickup_at))) s.comeback = true;

    if (g.games.mode === "teams" && g.team) {
      const total = t => (byGame[g.game] || []).filter(o => o.team === t).reduce((a, o) => a + o.pickups, 0);
      if (total(g.team) < total(g.team === 1 ? 2 : 1)) s.teamWins++;
    }
    for (const o of others) {
      if (lastVs[o.user_id] && g.pickups < o.pickups) s.revenge = true;
      lastVs[o.user_id] = o.pickups < g.pickups;
    }
  }
  return s;
}

// ---------- 3. The 3D medal ----------
const COLORS = {
  gold:    { metal: 0xF2B400, rim: 0xC98A00, face: ["#FFE27A", "#F2B400"] },   // earned
  mystery: { metal: 0x8C6CF0, rim: 0x5B3FC4, face: ["#D9CCFF", "#8C6CF0"] },   // mystery, earned
  locked:  { metal: 0xB9B3A6, rim: 0x8F8879, face: ["#E7E2D6", "#B9B3A6"] },   // not yet
};

function faceTexture(icon, look, locked) {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(200, 180, 40, 256, 256, 260);
  grad.addColorStop(0, look.face[0]);
  grad.addColorStop(1, look.face[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  // honeycomb ring
  g.strokeStyle = "rgba(255,255,255,.35)";
  g.lineWidth = 10;
  g.beginPath(); g.arc(256, 256, 214, 0, Math.PI * 2); g.stroke();
  g.textAlign = "center"; g.textBaseline = "middle";
  if (icon === "?") {
    g.fillStyle = "#4A4235";
    g.font = "900 320px system-ui, -apple-system, 'Segoe UI', sans-serif";
    g.fillText("?", 256, 280);
  } else {
    g.globalAlpha = locked ? 0.5 : 1;
    if (locked) g.filter = "grayscale(1)";
    g.font = "230px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
    g.fillText(icon, 256, 270);
    g.filter = "none"; g.globalAlpha = 1;
    if (locked) { g.font = "110px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif"; g.fillText("🔒", 380, 390); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function medal(icon, look, locked) {
  const group = new THREE.Group();
  const tex = faceTexture(icon, look, locked);
  const face = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.6, metalness: 0.1, roughness: 0.5 });
  const side = new THREE.MeshStandardMaterial({ color: look.rim, metalness: 0.9, roughness: 0.28 });
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.16, 96), side);
  coin.rotation.x = Math.PI / 2;                       // the coin's edge
  group.add(coin);
  // Front and back pictures sit just outside the coin, upright
  const front = new THREE.Mesh(new THREE.CircleGeometry(0.97, 96), face);
  front.position.z = 0.081;
  const back = new THREE.Mesh(new THREE.CircleGeometry(0.97, 96), face);
  back.position.z = -0.081;
  back.rotation.y = Math.PI;
  group.add(front, back);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.075, 24, 120),
    new THREE.MeshStandardMaterial({ color: look.metal, metalness: 0.95, roughness: 0.2 }));
  group.add(rim);
  // ribbon tab on top
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.1),
    new THREE.MeshStandardMaterial({ color: locked ? 0x9C968A : 0x1F1B16, metalness: 0.3, roughness: 0.6 }));
  tab.position.set(0, 1.12, 0);
  group.add(tab);
  return group;
}

function stage(renderer) {
  const scene = new THREE.Scene();
  // Soft studio reflections so the metal shines (built from a tiny scene, no files needed)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x3a3530);
  const lamp = (color, x, y, z, s) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m); };
  lamp(0xffffff, 0, 5, 5, 6); lamp(0xffe7a8, -6, 2, 2, 4); lamp(0xbfd4ff, 6, -1, 3, 4); lamp(0xffffff, 0, -5, 4, 3);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b5a3a, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 3, 4);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.12, 4.7);
  return { scene, camera };
}

function lookFor(b, earned) {
  if (!earned) return COLORS.locked;
  return b.mystery ? COLORS.mystery : COLORS.gold;
}
function iconFor(b, earned) {
  return b.mystery && !earned ? "?" : b.icon;
}

// One hidden renderer draws every medal into a picture
let painter = null;
function picture(b, earned) {
  if (!painter) {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(256, 256, false);
    renderer.toneMapping = THREE.NoToneMapping;
    painter = { renderer, ...stage(renderer) };
  }
  const m = medal(iconFor(b, earned), lookFor(b, earned), !earned);
  m.rotation.set(-0.12, 0.38, 0.04);                    // a slight tilt so it looks 3D
  painter.scene.add(m);
  painter.renderer.render(painter.scene, painter.camera);
  const url = painter.renderer.domElement.toDataURL("image/png");
  painter.scene.remove(m);
  m.traverse(o => { o.geometry?.dispose(); [].concat(o.material || []).forEach(x => { x.map?.dispose(); x.dispose(); }); });
  return url;
}

// ---------- 4. Big view: tap a medal to spin it ----------
let viewer = null;
function openViewer(b, earned, progress) {
  if (!viewer) {
    const wrap = document.createElement("div");
    wrap.className = "bdg-modal";
    wrap.innerHTML = `<div class="bdg-sheet" role="dialog" aria-modal="true">
      <button class="bdg-close" aria-label="Close">✕</button>
      <canvas class="bdg-canvas" width="600" height="600"></canvas>
      <p class="bdg-kind"></p><h3></h3><p class="bdg-desc"></p><div class="bdg-bar"><span></span></div><p class="bdg-prog"></p>
      <p class="bdg-tip">Drag to spin</p></div>`;
    document.body.append(wrap);
    const canvas = wrap.querySelector("canvas");
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.toneMapping = THREE.NoToneMapping;
    viewer = { wrap, canvas, renderer, ...stage(renderer), obj: null, spin: 0.9, rotY: 0, dragging: false, open: false };
    const close = () => { wrap.classList.remove("on"); viewer.open = false; };
    wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
    wrap.querySelector(".bdg-close").onclick = close;
    addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    let lastX = 0;
    canvas.addEventListener("pointerdown", e => { viewer.dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => { if (!viewer.dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; viewer.rotY += dx * 0.012; viewer.spin = dx * 0.6; });
    canvas.addEventListener("pointerup", () => { viewer.dragging = false; });
    let last = performance.now();
    const loop = now => {
      requestAnimationFrame(loop);
      if (!viewer.open || !viewer.obj) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!viewer.dragging) { viewer.spin += (0.9 - viewer.spin) * dt * 1.5; viewer.rotY += viewer.spin * dt; }
      viewer.obj.rotation.y = viewer.rotY;
      viewer.obj.position.y = Math.sin(now / 700) * 0.05;
      const size = canvas.clientWidth;
      if (canvas.width !== Math.round(size * renderer.getPixelRatio())) renderer.setSize(size, size, false);
      renderer.render(viewer.scene, viewer.camera);
    };
    requestAnimationFrame(loop);
  }
  if (viewer.obj) viewer.scene.remove(viewer.obj);
  viewer.obj = medal(iconFor(b, earned), lookFor(b, earned), !earned);
  viewer.scene.add(viewer.obj);
  viewer.rotY = -0.6; viewer.spin = 6;                   // a quick spin when it opens
  const w = viewer.wrap;
  w.querySelector(".bdg-kind").textContent = b.mystery ? (earned ? "Mystery badge · found!" : "Mystery badge") : earned ? "Badge · earned" : "Badge · locked";
  w.querySelector("h3").textContent = b.mystery && !earned ? "???" : b.name;
  w.querySelector(".bdg-desc").textContent = b.mystery && !earned ? "Nobody tells you how to get this one. Keep playing." : b.desc;
  const [cur, goal] = progress;
  const showBar = !b.mystery && !earned && goal > 1;
  w.querySelector(".bdg-bar").hidden = !showBar;
  w.querySelector(".bdg-bar span").style.width = Math.min(100, cur / goal * 100) + "%";
  w.querySelector(".bdg-prog").textContent = showBar ? `${cur} / ${goal}${b.unit ? " " + b.unit : ""}` : earned ? "✓ You have this one" : "";
  w.classList.add("on");
  viewer.open = true;
}

// ---------- 5. Put the badges on the page ----------
const CSS = `
.bdg-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.bdg-count{font-size:13px;font-weight:700;color:var(--ink-2,#5E574B)}
.bdg-label{margin:16px 0 8px;font-size:13px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-2,#5E574B)}
.bdg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px}
.bdg{display:grid;justify-items:center;gap:4px;padding:8px 4px 10px;border:0;border-radius:16px;background:var(--sand,#F5EEDB);font:inherit;color:inherit;cursor:pointer;transition:transform .15s}
.bdg:hover{transform:translateY(-3px)}
.bdg img{width:78px;height:78px}
.bdg b{font-size:12px;line-height:1.2;text-align:center}
.bdg small{font-size:11px;color:var(--ink-2,#5E574B)}
.bdg.locked b{color:var(--ink-2,#5E574B)}
.bdg-modal{position:fixed;inset:0;z-index:100;display:none;place-items:center;padding:16px;background:rgba(31,27,22,.55)}
.bdg-modal.on{display:grid}
.bdg-sheet{position:relative;width:min(360px,100%);padding:20px 22px 22px;border-radius:24px;background:#FFF8E6;text-align:center}
.bdg-canvas{width:100%;max-width:260px;aspect-ratio:1;touch-action:none;cursor:grab}
.bdg-close{position:absolute;top:12px;right:12px;width:36px;height:36px;border:0;border-radius:50%;background:#1F1B16;color:#fff;font-size:16px;cursor:pointer}
.bdg-kind{margin:4px 0 2px;font-size:12px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#8A6A10}
.bdg-sheet h3{margin:0 0 6px;font-size:22px}
.bdg-desc{margin:0;color:#5E574B;font-size:14px}
.bdg-bar{height:8px;margin:12px 0 4px;border-radius:99px;background:#EAE2CC;overflow:hidden}
.bdg-bar span{display:block;height:100%;background:#F2B400}
.bdg-prog{margin:0;font-size:13px;font-weight:700}
.bdg-tip{margin:8px 0 0;font-size:12px;color:#8F8879}`;

export function show(box, stats) {
  if (!document.getElementById("bdg-css")) {
    const st = document.createElement("style"); st.id = "bdg-css"; st.textContent = CSS; document.head.append(st);
  }
  const results = BADGES.map(b => { const p = b.check(stats); return { b, p, earned: p[0] >= p[1] }; });
  const reg = results.filter(r => !r.b.mystery), mys = results.filter(r => r.b.mystery);
  const tile = r => {
    const btn = document.createElement("button");
    btn.className = "bdg" + (r.earned ? "" : " locked");
    const img = new Image();
    img.alt = r.b.mystery && !r.earned ? "Mystery badge" : r.b.name;
    try { img.src = picture(r.b, r.earned); } catch { img.alt += " (3D not supported)"; }
    const name = document.createElement("b");
    name.textContent = r.b.mystery && !r.earned ? "???" : r.b.name;
    const sub = document.createElement("small");
    sub.textContent = r.earned ? "Earned" : r.b.mystery ? "Mystery" : `${Math.min(r.p[0], r.p[1])}/${r.p[1]}${r.b.unit ? " " + r.b.unit : ""}`;
    btn.append(img, name, sub);
    btn.onclick = () => openViewer(r.b, r.earned, r.p);
    return btn;
  };
  const head = document.createElement("div"); head.className = "bdg-head";
  const h = document.createElement("h2"); h.textContent = "Badges";
  const count = document.createElement("span"); count.className = "bdg-count";
  count.textContent = `${reg.filter(r => r.earned).length}/${reg.length} earned · ${mys.filter(r => r.earned).length}/${mys.length} mystery found`;
  head.append(h, count);
  const label = t => { const p = document.createElement("p"); p.className = "bdg-label"; p.textContent = t; return p; };
  const grid = list => { const d = document.createElement("div"); d.className = "bdg-grid"; d.append(...list.map(tile)); return d; };
  box.replaceChildren(head, label("Badges"), grid(reg), label("Mystery badges · do something unusual to find out"), grid(mys));
}

// ---------- 6. On the dashboard: load your games and show them ----------
async function boot() {
  const box = document.getElementById("badges");
  if (!box || typeof sb === "undefined") return;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const me = session.user.id;
  const { data: mine } = await sb.from("results")
    .select("game, user_id, pickups, pickup_times, first_pickup_at, team, pass_used, games!inner(status, start_time, end_time, mode)")
    .eq("user_id", me).eq("games.status", "ended");
  const games = (mine || []).filter(r => r.games.start_time && r.games.end_time);
  let all = [];
  if (games.length) {
    const { data } = await sb.from("results").select("game, user_id, pickups, team, first_pickup_at").in("game", games.map(g => g.game));
    all = data || [];
  }
  const { count } = await sb.from("friendships").select("id", { count: "exact", head: true })
    .eq("status", "accepted").or(`requester.eq.${me},addressee.eq.${me}`);
  show(box, collect(games, all, count || 0));
}
boot();
