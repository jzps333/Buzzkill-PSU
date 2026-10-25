/*
  Buzz in 3D (three.js). buzz.js loads this automatically and swaps the flat SVG for a live 3D bee,
  and companion.js uses it for the bee that follows you around the site. No WebGL = the SVG stays.

  mount(el, { design, follow })
      draws Buzz in el and keeps him buzzing. He reads el's classes every frame:
        bz-mood-worried  worried face (where the design has one), darting eyes
        bz-panic         wings go crazy, he shakes
      follow: true = he's the companion: always animating, turns to face where he flies (see steer)
      Returns { dispose(), steer(vx, vy), busy }   (busy = someone is hovering or spinning him)

  Play with him: hover = he turns to look at you, drag = spin him to see every side, click / tap = a flip.

  Designs (bee-designs.js): cute (the site's Buzz), honeybee, sleek, classic.
  Pick one with ?bee=sleek in the address; it's remembered on this device.
*/
import * as THREE from "./vendor/three.module.min.js";
import { honeybee, sleek, cute } from "./bee-designs.js";

const YELLOW = 0xffc93c, INK = 0x2b2118, WING = 0xe3f4ff, CHEEK = 0xff9aae, PENCIL = 0xffd25a;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Cartoon shading: 3 flat steps of light instead of a smooth gradient
const steps = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
steps.minFilter = steps.magFilter = THREE.NearestFilter;
steps.needsUpdate = true;
const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: steps, ...extra });

// Yellow body with two ink stripes on the lower half
function stripes() {
  const c = document.createElement("canvas");
  c.width = 8; c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#FFC93C"; g.fillRect(0, 0, 8, 256);
  g.fillStyle = "#2B2118";
  g.fillRect(0, 158, 8, 26);          // v measured from the top of the texture
  g.fillRect(0, 205, 8, 26);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function outline(mesh, width = 1.06) {
  // The "inked" cartoon outline: a slightly bigger copy, inside out, in ink
  const o = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide }));
  o.scale.setScalar(width);
  mesh.add(o);
  return o;
}

function tube(points, radius) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 20, radius, 8), toon(INK));
}

export function classic() {
  const bee = new THREE.Group();
  const ink = toon(INK);

  // Body (Buzz is one round chubby bee: the face is on the body)
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), toon(0xffffff, { map: stripes() }));
  body.scale.set(1, 1.05, 0.95);
  outline(body, 1.045);
  bee.add(body);

  // Stinger
  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.32, 16), ink);
  stinger.position.set(0, -0.95, -0.35);
  stinger.rotation.x = Math.PI + 0.7;
  bee.add(stinger);

  // Feet
  for (const x of [-0.32, 0.32]) {
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), ink);
    foot.scale.set(1, 0.55, 1.2);
    foot.position.set(x, -1.02, 0.15);
    bee.add(foot);
  }

  // Arms: left waves, right holds a pencil
  const armL = tube([[-0.85, -0.15, 0.3], [-1.12, 0.05, 0.35], [-1.18, 0.35, 0.3]], 0.065);
  const handL = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), ink);
  handL.position.set(-1.18, 0.38, 0.3);
  const waving = new THREE.Group();
  waving.add(armL, handL);
  bee.add(waving);

  const armR = tube([[0.85, -0.15, 0.3], [1.08, -0.08, 0.4], [1.15, 0.12, 0.45]], 0.065);
  const handR = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), ink);
  handR.position.set(1.15, 0.12, 0.45);
  const pencil = new THREE.Group();
  const wood = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 6), toon(PENCIL));
  const eraser = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 6), toon(0xff8fa3));
  eraser.position.y = 0.35;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 6), toon(0xf6d7b0));
  tip.position.y = -0.38; tip.rotation.x = Math.PI;
  pencil.add(wood, eraser, tip);
  pencil.position.set(1.18, 0.2, 0.5);
  pencil.rotation.z = -0.35;
  bee.add(armR, handR, pencil);

  // Face (on the front of the body, +z)
  const face = new THREE.Group();
  face.position.set(0, 0.2, 0);
  bee.add(face);

  const eyes = new THREE.Group();
  for (const x of [-0.3, 0.3]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 16), ink);
    eye.position.set(x, 0, 0.9);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    shine.position.set(0.035, 0.045, 0.09);
    eye.add(shine);
    eyes.add(eye);
  }
  face.add(eyes);

  // Glasses: two rings and a bridge, plus a see-through lens
  for (const x of [-0.3, 0.3]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 32), ink);
    ring.position.set(x, 0, 0.95);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
    lens.position.set(x, 0, 0.955);
    face.add(ring, lens);
  }
  const bridge = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.025, 8, 16, Math.PI), ink);
  bridge.position.set(0, 0.02, 0.98);
  face.add(bridge);

  // Cheeks
  for (const x of [-0.52, 0.52]) {
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), toon(CHEEK));
    cheek.scale.set(1.3, 0.75, 0.4);
    cheek.position.set(x, -0.24, 0.8);
    cheek.lookAt(x * 3, -0.24, 4);
    face.add(cheek);
  }

  // Mouths: a smile, or a worried "o" with raised brows
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 8, 20, Math.PI), ink);
  smile.position.set(0, -0.28, 0.93);
  smile.rotation.z = Math.PI;
  const gasp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), ink);
  gasp.scale.set(0.85, 1.1, 0.5);
  gasp.position.set(0, -0.32, 0.92);
  const brows = new THREE.Group();
  for (const s of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.14, 4, 8), ink);
    brow.position.set(s * 0.33, 0.3, 0.92);
    brow.rotation.z = Math.PI / 2 - s * 0.35;
    brows.add(brow);
  }
  face.add(smile, gasp, brows);

  // Antennae
  for (const s of [-1, 1]) {
    bee.add(tube([[s * 0.15, 0.9, 0.1], [s * 0.25, 1.25, 0.15], [s * 0.45, 1.5, 0.1]], 0.035));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 12), ink);
    knob.position.set(s * 0.46, 1.52, 0.1);
    bee.add(knob);
  }

  // Graduation cap
  const cap = new THREE.Group();
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.22, 24), ink);
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.06, 1.05), toon(0x3e3226));
  board.position.y = 0.13;
  board.rotation.y = Math.PI / 4;
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), toon(YELLOW));
  button.position.y = 0.17;
  const tassel = tube([[0, 0.17, 0], [0.35, 0.16, 0.2], [0.55, 0.1, 0.3], [0.58, -0.2, 0.3]], 0.02);
  tassel.material = toon(YELLOW);
  const tasselEnd = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, 0.14, 8), toon(YELLOW));
  tasselEnd.position.set(0.58, -0.27, 0.3);
  cap.add(crown, board, button, tassel, tasselEnd);
  cap.position.set(0, 0.98, -0.02);
  cap.rotation.set(-0.12, 0, 0.08);
  bee.add(cap);

  // Wings: see-through, hinged at the back of the shoulders
  const wingShape = new THREE.Shape();
  wingShape.absellipse(0, 0, 0.72, 0.42, 0, Math.PI * 2);
  const wingGeo = new THREE.ShapeGeometry(wingShape, 32);
  wingGeo.translate(0.62, 0.14, 0);                     // hinge at the inner end
  const wingMat = new THREE.MeshBasicMaterial({ color: WING, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: INK });
  const edgeGeo = new THREE.BufferGeometry().setFromPoints(
    wingShape.getPoints(48).map(p => new THREE.Vector3(p.x + 0.62, p.y + 0.14, 0)));
  const wings = [];
  for (const s of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(s * 0.55, 0.5, -0.5);
    const wing = new THREE.Mesh(wingGeo, wingMat);
    wing.add(new THREE.LineLoop(edgeGeo, edgeMat));
    wing.scale.x = s;
    wing.rotation.z = 0.5 * s;
    hinge.add(wing);
    bee.add(hinge);
    wings.push({ pose: f => hinge.rotation.set(0.2, s * (-0.35 + f * 0.55), 0) });
  }

  return { bee, eyes, smile, gasp, brows, waving, wings, view: { z: 7.6, y: 0.3, lookY: 0.2, yaw: 0 } };
}

const DESIGNS = { honeybee, sleek, cute, classic };
export const DESIGN_NAMES = Object.keys(DESIGNS);
const DEFAULT_DESIGN = "cute";

export function chosenDesign() {
  const asked = new URLSearchParams(location.search).get("bee");
  let saved = null;
  try {
    if (DESIGNS[asked]) localStorage.setItem("bz-design", asked);
    saved = localStorage.getItem("bz-design");
  } catch { /* private mode: just don't remember */ }
  return DESIGNS[asked] ? asked : DESIGNS[saved] ? saved : DEFAULT_DESIGN;
}

export function mount(el, { design = chosenDesign(), follow = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "bz-canvas";
  canvas.setAttribute("aria-hidden", "true");
  el.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xffe6b0, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(2, 3, 4);
  const rim = new THREE.DirectionalLight(0xfff1c9, 0.9);
  rim.position.set(-3, 2, -3);
  scene.add(sun, rim);

  const parts = (DESIGNS[design] || DESIGNS[DEFAULT_DESIGN])();
  const view = parts.view;
  const camera = new THREE.PerspectiveCamera(30, 210 / 215, 0.1, 50);
  camera.position.set(0, view.y, view.z);
  camera.lookAt(0, view.lookY, 0);

  const rig = new THREE.Group();           // hover + sway + turning happen on the rig, so the bee's own pose stays clean
  rig.add(parts.bee);
  scene.add(rig);

  function resize() {
    const w = el.clientWidth || 160;
    const h = Math.round(w * 215 / 210);
    renderer.setSize(w, h, false);
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.aspectRatio = "210 / 215";
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  // Only animate while he's on screen and the tab is visible (saves battery on phones)
  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
  if (!follow) io.observe(el);

  // Companion steering: which way he's flying
  let vx = 0, vy = 0, facing = 1, yaw = view.yaw, pitch = 0, bank = 0;

  // Hover / drag / click
  const me = { hover: false, lx: 0, ly: 0, look: 0, lookUp: 0, drag: false, yaw: 0, pitch: 0, spin: 0, released: -1e9, flip: 0 };
  let px = 0, py = 0, pt = 0, moved = 0;
  canvas.style.touchAction = "pan-y";           // vertical swipes still scroll the page on phones
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerenter", () => { me.hover = true; });
  canvas.addEventListener("pointerleave", () => { me.hover = false; });
  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect();
    me.lx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    me.ly = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    if (!me.drag) return;
    const dx = e.clientX - px, dy = e.clientY - py, now = performance.now();
    me.yaw += dx * 0.014;
    me.pitch = Math.max(-1.1, Math.min(1.1, me.pitch + dy * 0.01));
    me.spin = (dx * 0.014) / Math.max(0.008, (now - pt) / 1000);
    moved += Math.abs(dx) + Math.abs(dy);
    px = e.clientX; py = e.clientY; pt = now;
  });
  canvas.addEventListener("pointerdown", e => {
    me.drag = true; moved = 0; me.spin = 0;
    px = e.clientX; py = e.clientY; pt = performance.now();
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  const letGo = () => {
    if (!me.drag) return;
    me.drag = false;
    me.released = performance.now();
    canvas.style.cursor = "grab";
    if (moved < 6) me.flip = 1;                 // a click, not a drag: do a flip
  };
  canvas.addEventListener("pointerup", letGo);
  canvas.addEventListener("pointercancel", letGo);

  const seed = Math.random() * 100;
  let raf = 0, last = 0, nextBlink = 2 + Math.random() * 3, blink = 0, look = 0, lookTarget = 0, lookAt = 0;
  const eyesX = parts.eyes ? parts.eyes.position.x : 0;

  function frame(ms) {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    if (ms - last < 1000 / 40) return;      // ~40 fps is plenty for a mascot
    const dt = Math.min(0.1, (ms - last) / 1000);
    last = ms;
    const t = ms / 1000 + seed;

    const worried = el.classList.contains("bz-mood-worried");
    const panic = el.classList.contains("bz-panic");
    const calm = reduceMotion ? 0.25 : 1;

    // Which way to face. In place: a slow look around. Following: turn toward where he's going.
    let yawTarget = view.yaw + Math.sin(t * 0.6) * 0.45 * calm;
    if (follow) {
      const speed = Math.hypot(vx, vy);
      if (Math.abs(vx) > 1.5) facing = Math.sign(vx);
      if (parts.profile) yawTarget = facing * (speed > 2 ? 1.45 : view.yaw);
      else yawTarget = Math.max(-0.9, Math.min(0.9, vx * 0.05)) + Math.sin(t * 0.6) * 0.2;
      // nose down a little when he speeds up, bank into turns
      const pitchTarget = Math.max(-0.35, Math.min(0.35, (parts.profile ? -1 : 1) * vy * 0.012 + (parts.profile ? 0 : speed * 0.006)));
      pitch += (pitchTarget - pitch) * Math.min(1, dt * 6);
      bank += (Math.max(-0.4, Math.min(0.4, -vx * 0.01)) - bank) * Math.min(1, dt * 6);
    }
    // Hovered: turn to look at the pointer
    if (me.hover && !me.drag) yawTarget = me.lx * 0.8;
    me.look += ((me.hover ? me.ly * 0.4 : 0) - me.look) * Math.min(1, dt * 6);
    yaw += (yawTarget - yaw) * Math.min(1, dt * (follow ? 5 : 3));

    // Dragged: he keeps spinning a little after you let go, then turns back around
    if (!me.drag) {
      me.yaw += me.spin * dt;
      me.spin *= Math.pow(0.04, dt);
      if (Math.abs(me.spin) < 0.4 && ms - me.released > 900) {
        me.yaw = Math.atan2(Math.sin(me.yaw), Math.cos(me.yaw));     // take the short way back
        const back = Math.min(1, dt * 2.5);
        me.yaw -= me.yaw * back;
        me.pitch -= me.pitch * back;
      }
    }
    // Clicked: a full flip with a little hop
    me.flip = Math.max(0, me.flip - dt * 1.3);
    const f = 1 - me.flip, flipping = me.flip > 0;
    const flipTurn = flipping ? Math.PI * 2 * (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2) : 0;
    const hop = flipping ? Math.sin(Math.PI * f) * 0.35 : 0;

    // Hover in a lazy figure-eight, plus a tiny buzz jitter
    rig.position.set(Math.sin(t * 0.9) * 0.12 * calm, Math.sin(t * 1.8) * 0.12 * calm + hop, 0);
    rig.rotation.set((follow ? pitch : 0) + me.pitch + me.look, yaw + me.yaw + flipTurn,
      follow ? bank : Math.sin(t * 0.9) * 0.06 * calm);
    const jitter = (panic ? 0.06 : 0.012) * calm;
    parts.bee.position.set((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter, 0);
    parts.bee.rotation.z = panic ? Math.sin(t * 40) * 0.08 : 0;

    // Wings: a fast blur of flapping. Panic = even faster
    const flap = Math.sin(t * (reduceMotion ? 8 : panic ? 70 : me.hover || me.drag ? 50 : 38));
    for (const w of parts.wings) w.pose(flap);

    // Wave hello (happy), or flail (panic)
    if (parts.waving) parts.waving.rotation.z = panic ? Math.sin(t * 25) * 0.25 : Math.sin(t * 3) * 0.12 * calm;

    // Face
    if (parts.smile) parts.smile.visible = !worried;
    if (parts.gasp) parts.gasp.visible = worried;
    if (parts.brows) parts.brows.visible = worried;
    if (parts.eyes && !parts.profile) {
      nextBlink -= dt;
      if (nextBlink <= 0) { blink = 0.15; nextBlink = 2.5 + Math.random() * 3; }
      blink = Math.max(0, blink - dt);
      parts.eyes.scale.y = blink > 0 ? 0.15 : 1;
      // Worried: eyes dart around
      if (worried && t > lookAt) { lookTarget = (Math.random() - 0.5) * 0.12; lookAt = t + 0.4 + Math.random() * 0.6; }
      if (!worried) lookTarget = me.hover ? me.lx * 0.05 : 0;      // eyes follow the pointer
      look += (lookTarget - look) * Math.min(1, dt * 12);
      parts.eyes.position.x = eyesX + look;
    }

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    steer(x, y) { vx = x; vy = y; },
    get busy() { return me.hover || me.drag || me.flip > 0; },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      renderer.dispose();
      canvas.remove();
    },
  };
}
