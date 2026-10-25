/*
  Buzz follows you around the site. Add to any page:
    <script type="module" src="companion.js"></script>

  Desktop: he flies after your mouse and hovers just above and to the right of it, so he never covers what you click.
  Move toward him and he stays put: hover = he looks at you, drag = spin him around, click = a flip.
  Phone: he rests in the bottom corner and flies to wherever you tap.
  He never parks on top of a button, link or text box: if his spot would cover one, he moves just beside it.
  Leave him alone for a few seconds and he wanders around nearby.
  Off when the user prefers reduced motion, on pages that set <body data-no-companion>, or with ?companion=off.
*/
import { mount } from "./bee3d.js";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const off = new URLSearchParams(location.search).get("companion") === "off" || document.body.hasAttribute("data-no-companion");
let webgl = false;
try { webgl = !!document.createElement("canvas").getContext("webgl2"); } catch { /* no 3D */ }

if (!reduce && !off && webgl) start();

function start() {
  const touch = matchMedia("(pointer: coarse)").matches;
  const size = touch ? 72 : 96;

  const el = document.createElement("div");
  el.className = "bz-companion";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed", left: "0", top: "0", width: size + "px", zIndex: "60",
    pointerEvents: "none", willChange: "transform",
  });
  document.body.append(el);
  const bee = mount(el, { follow: true });
  const near = (x, y, r) => Math.hypot(x - (pos.x + size / 2), y - (pos.y + size / 2)) < r;
  const over = (x, y) => x > pos.x && x < pos.x + size && y > pos.y && y < pos.y + size;

  // Where he rests on a phone, or before the mouse moves
  const rest = () => ({ x: innerWidth - size - 16, y: innerHeight - size - 24 });
  let pos = rest(), vel = { x: 0, y: 0 }, target = rest();
  let lastMove = -1e9, wanderFrom = { ...target };

  function aim(x, y) {
    // Above-right of the pointer, kept on screen
    target = {
      x: Math.min(innerWidth - size - 4, Math.max(4, x + 18)),
      y: Math.min(innerHeight - size - 4, Math.max(4, y - size - 6)),
    };
    wanderFrom = { ...target };
    lastMove = performance.now();
  }

  if (touch) addEventListener("pointerdown", e => aim(e.clientX - size / 2, e.clientY + size / 2), { passive: true });
  else addEventListener("pointermove", e => {
    // Over him: let the pointer reach him (and not the page underneath) so he can be hovered, spun and clicked
    el.style.pointerEvents = over(e.clientX, e.clientY) || bee.busy ? "auto" : "none";
    // Coming toward him, or playing with him: he stays put. Otherwise he follows.
    if (bee.busy || near(e.clientX, e.clientY, size * 1.05)) { lastMove = performance.now(); return; }
    aim(e.clientX, e.clientY);
  }, { passive: true });
  addEventListener("resize", () => { if (touch) target = rest(); });

  // ---------- Stay off anything clickable ----------
  const CLICKABLE = "a[href], button, input, select, textarea, summary, label, [role=button], [onclick], [tabindex]:not([tabindex='-1'])";
  let boxes = [], boxesAt = 0;
  function clickables(now) {
    if (now - boxesAt < 400) return boxes;           // re-measure a couple of times a second
    boxesAt = now;
    const screen = innerWidth * innerHeight;
    boxes = [];
    for (const n of document.querySelectorAll(CLICKABLE)) {
      if (el.contains(n) || n.closest("[hidden]")) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (r.width * r.height > screen * 0.4) continue;  // giant clickable areas (whole cards): ignore, or he'd have nowhere to go
      boxes.push(r);
    }
    return boxes;
  }
  const PAD = 8;
  const onScreen = p => ({ x: Math.min(innerWidth - size - 4, Math.max(4, p.x)), y: Math.min(innerHeight - size - 4, Math.max(4, p.y)) });
  const hits = (p, list) => list.find(r => p.x < r.right + PAD && p.x + size > r.left - PAD && p.y < r.bottom + PAD && p.y + size > r.top - PAD);
  let dodge = null;                                    // where he parked last time he had to dodge (keeps him from jittering)
  function clear(goal, now) {
    const list = clickables(now);
    if (!hits(goal, list)) { dodge = null; return goal; }
    if (dodge && !hits(dodge, list) && Math.hypot(dodge.x - goal.x, dodge.y - goal.y) < size * 2.5) return dodge;
    // Try spots just outside whatever he'd cover: above, below, left, right. Pick the closest free one.
    let best = null, bestD = Infinity, tries = [goal];
    for (let round = 0; round < 3; round++) {
      const next = [];
      for (const p of tries) {
        const r = hits(p, list);
        if (!r) continue;
        for (const c of [
          { x: p.x, y: r.top - PAD - size }, { x: p.x, y: r.bottom + PAD },
          { x: r.left - PAD - size, y: p.y }, { x: r.right + PAD, y: p.y },
        ].map(onScreen)) {
          const d = Math.hypot(c.x - goal.x, c.y - goal.y);
          if (!hits(c, list)) { if (d < bestD) { best = c; bestD = d; } }
          else next.push(c);
        }
      }
      if (best) break;
      tries = next.slice(0, 12);
    }
    // Crowded (like the nav bar)? Search outward in rings for the nearest free spot.
    for (let rad = 24; !best && rad <= 480; rad += 24) {
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        const c = onScreen({ x: goal.x + Math.cos(a) * rad, y: goal.y + Math.sin(a) * rad });
        const d = Math.hypot(c.x - goal.x, c.y - goal.y);
        if (!hits(c, list) && d < bestD) { best = c; bestD = d; }
      }
    }
    dodge = best || goal;
    return dodge;
  }
  addEventListener("scroll", () => { boxesAt = 0; }, { passive: true });

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (document.hidden) return;

    // Idle for a while: lazy loops around where he last stopped
    const idle = (now - lastMove) / 1000;
    let goal = target;
    if (idle > 3 && !bee.busy) {
      const t = now / 1000;
      goal = { x: wanderFrom.x + Math.sin(t * 0.7) * 50, y: wanderFrom.y + Math.sin(t * 1.3) * 22 };
      goal.x = Math.min(innerWidth - size - 4, Math.max(4, goal.x));
      goal.y = Math.min(innerHeight - size - 4, Math.max(4, goal.y));
    }

    goal = clear(goal, now);

    // Springy chase: quick to start, overshoots a little, settles
    const k = 26, damp = 7.5;
    vel.x += ((goal.x - pos.x) * k - vel.x * damp) * dt;
    vel.y += ((goal.y - pos.y) * k - vel.y * damp) * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    el.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`;
    bee.steer(vel.x / 20, vel.y / 20);      // so he faces where he's flying
  }
  requestAnimationFrame(frame);
}
