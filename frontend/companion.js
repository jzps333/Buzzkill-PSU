/*
  Buzz follows you around the site. Add to any page:
    <script type="module" src="companion.js"></script>

  Desktop: he flies after your mouse and hovers just above and to the right of it, so he never covers what you click.
  Phone: he rests in the bottom corner and flies to wherever you tap.
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
  else addEventListener("pointermove", e => aim(e.clientX, e.clientY), { passive: true });
  addEventListener("resize", () => { if (touch) target = rest(); });

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (document.hidden) return;

    // Idle for a while: lazy loops around where he last stopped
    const idle = (now - lastMove) / 1000;
    let goal = target;
    if (idle > 3) {
      const t = now / 1000;
      goal = { x: wanderFrom.x + Math.sin(t * 0.7) * 50, y: wanderFrom.y + Math.sin(t * 1.3) * 22 };
      goal.x = Math.min(innerWidth - size - 4, Math.max(4, goal.x));
      goal.y = Math.min(innerHeight - size - 4, Math.max(4, goal.y));
    }

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
