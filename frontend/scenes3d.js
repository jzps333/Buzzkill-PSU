/*
  The 3D pictures on the home page (three.js): the brick, a phone feeling gravity, a phone being shaken.
  Drag to spin any of them; tap to make something happen. Without WebGL the flat CSS pictures stay.

    <div class="hl-art"> ...flat picture... <div data-scene="brick"></div> </div>
    <script type="module" src="scenes3d.js"></script>
*/
import * as THREE from "./vendor/three.module.min.js";

const INK = 0x1f1b16, HONEY = 0xf5d35a, CREAM = 0xfffaeb;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...extra });

function textTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const redraw = (...a) => { draw(c.getContext("2d"), w, h, ...a); t.needsUpdate = true; };
  redraw();
  return { texture: t, redraw };
}

// Rounded box: a box with bevelled edges (three.js core has none)
function roundedBox(w, h, d, r, material) {
  const shape = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + d - r); shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  shape.lineTo(x + r, y + d); shape.quadraticCurveTo(x, y + d, x, y + d - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h - r, bevelEnabled: true, bevelThickness: r / 2, bevelSize: r / 2, bevelSegments: 4, curveSegments: 8 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h / 2 + r / 4, 0);
  return new THREE.Mesh(geo, material);
}

// ---------------------------------------------------------------------------------------------
// The shared stage: canvas, lights, camera, drag-to-spin with a little inertia, hover tilt, tap
// ---------------------------------------------------------------------------------------------
function stage(el, { cam = [0, 3.2, 7.5], look = [0, 0, 0], yaw = 0.5, build }) {
  const canvas = document.createElement("canvas");
  canvas.className = "scene-canvas";
  el.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe8d9b5, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(3, 6, 4);
  const rim = new THREE.DirectionalLight(0xfff1c9, 0.8);
  rim.position.set(-4, 3, -4);
  scene.add(sun, rim);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(...cam);
  camera.lookAt(...look);

  const spin = new THREE.Group();             // what dragging rotates
  scene.add(spin);
  const thing = build(spin, scene);

  function resize() {
    const w = el.clientWidth || 300, h = el.clientHeight || 260;
    renderer.setSize(w, h, false);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(el);

  // Drag / hover / tap
  const me = { yaw: 0, pitch: 0, vel: 0, drag: false, hover: false, lx: 0, ly: 0, released: -1e9 };
  let px = 0, py = 0, pt = 0, moved = 0;
  canvas.style.touchAction = "pan-y";
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerenter", () => { me.hover = true; });
  canvas.addEventListener("pointerleave", () => { me.hover = false; });
  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect();
    me.lx = ((e.clientX - r.left) / r.width) * 2 - 1;
    me.ly = ((e.clientY - r.top) / r.height) * 2 - 1;
    if (!me.drag) return;
    const dx = e.clientX - px, dy = e.clientY - py, now = performance.now();
    me.yaw += dx * 0.012;
    me.pitch = Math.max(-0.5, Math.min(0.6, me.pitch + dy * 0.006));
    me.vel = (dx * 0.012) / Math.max(0.008, (now - pt) / 1000);
    moved += Math.abs(dx) + Math.abs(dy);
    px = e.clientX; py = e.clientY; pt = now;
  });
  canvas.addEventListener("pointerdown", e => {
    me.drag = true; moved = 0; me.vel = 0;
    px = e.clientX; py = e.clientY; pt = performance.now();
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  const up = () => {
    if (!me.drag) return;
    me.drag = false; me.released = performance.now();
    canvas.style.cursor = "grab";
    if (moved < 6) thing.tap?.();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(el);

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    if (!me.drag) {
      me.yaw += me.vel * dt;
      me.vel *= Math.pow(0.05, dt);
      if (Math.abs(me.vel) < 0.3 && now - me.released > 1500) {      // drift back to the best angle
        me.yaw = Math.atan2(Math.sin(me.yaw), Math.cos(me.yaw));
        me.yaw -= me.yaw * Math.min(1, dt * 1.5);
        me.pitch -= me.pitch * Math.min(1, dt * 1.5);
      }
    }
    const idle = reduce ? 0 : Math.sin(t * 0.4) * 0.12;
    const lean = me.hover && !me.drag ? me.lx * 0.25 : 0;
    spin.rotation.y += (yaw + idle + lean + me.yaw - spin.rotation.y) * Math.min(1, dt * 8);
    spin.rotation.x += (me.pitch + (me.hover && !me.drag ? me.ly * 0.08 : 0) - spin.rotation.x) * Math.min(1, dt * 8);

    thing.update?.(t, dt);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  el.closest(".hl-art")?.classList.add("has-3d");
}

// ---------------------------------------------------------------------------------------------
// 1. The brick: dark box, glowing touch pad, speaker grille, Raspberry Pi, NFC sticker, the JBL
// ---------------------------------------------------------------------------------------------
const LINES = [
  "Alex picked up. Again. Sam is still clean.",
  "New game. Your PIN is 4, F, 2, A, 9, C.",
  "Focus time. 18 minutes left. Sam is winning.",
  "Game on. Phones down. Good luck.",
];

function brickScene(el) {
  const bubble = el.parentElement.querySelector(".say");
  let line = 0;
  stage(el, {
    cam: [0, 3.6, 7.2], look: [0.3, 0, 0], yaw: -0.45,
    build(root) {
      const body = roundedBox(3.2, 0.9, 2.0, 0.22, std(0x2b2620, { roughness: 0.7 }));
      root.add(body);

      // Touch pad
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 40), std(HONEY, { emissive: HONEY, emissiveIntensity: 0.1 }));
      pad.position.set(-0.85, 0.46, 0.1);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.04, 10, 40), std(0x8a6a10));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(-0.85, 0.47, 0.1);
      const label = textTexture(128, 64, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = "#1F1B16"; g.font = "800 34px system-ui"; g.textAlign = "center"; g.fillText("TAP", w / 2, 44); });
      const tapText = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshBasicMaterial({ map: label.texture, transparent: true }));
      tapText.rotation.x = -Math.PI / 2;
      tapText.position.set(-0.85, 0.505, 0.1);
      root.add(pad, ring, tapText);

      // Speaker grille
      const dot = new THREE.CylinderGeometry(0.055, 0.055, 0.02, 12), dotMat = std(0x5a5245);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
        const d = new THREE.Mesh(dot, dotMat);
        d.position.set(0.3 + c * 0.2, 0.455, -0.55 + r * 0.2);
        root.add(d);
      }

      // Raspberry Pi: green board with chips and the gold GPIO header
      const pi = new THREE.Group();
      pi.add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.6), std(0x2f8a55)));
      const chip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.22), std(0x222222, { roughness: 0.3 }));
      chip.position.set(-0.15, 0.04, 0.02);
      const chip2 = chip.clone(); chip2.scale.set(0.6, 1, 0.8); chip2.position.set(0.18, 0.04, 0.08);
      const usb = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.2), std(0xc9c9c9, { metalness: 0.6, roughness: 0.3 }));
      usb.position.set(0.36, 0.07, -0.12);
      const pins = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.06), std(0xd4a017, { metalness: 0.8, roughness: 0.3 }));
      pins.position.set(0, 0.05, -0.25);
      pi.add(chip, chip2, usb, pins);
      pi.position.set(0.75, 0.47, 0.42);
      pi.rotation.y = 0.05;
      root.add(pi);

      // NFC sticker
      const nfc = textTexture(128, 128, (g, w, h) => {
        g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
        g.strokeStyle = "#1F1B16"; g.lineWidth = 5;
        for (const r of [18, 30, 42]) { g.beginPath(); g.arc(46, 64, r, -0.7, 0.7); g.stroke(); }
        g.fillStyle = "#1F1B16"; g.font = "800 26px system-ui"; g.fillText("NFC", 66, 74);
      });
      const sticker = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: nfc.texture }));
      sticker.rotation.x = -Math.PI / 2;
      sticker.position.set(-0.1, 0.456, -0.62);
      root.add(sticker);

      // The JBL Go 3 next to it, and sound rings coming out of it
      const jbl = roundedBox(1.0, 0.75, 0.42, 0.16, std(0x24456e, { roughness: 0.9 }));
      jbl.position.set(2.35, -0.07, 0.2);
      jbl.rotation.z = 0.15;
      const logo = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), std(0xff6a13));
      logo.position.set(2.39, 0.0, 0.42);
      logo.rotation.y = 0.15;
      root.add(jbl, logo);
      const rings = [];
      for (let i = 0; i < 3; i++) {
        const w = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 8, 40, Math.PI * 0.9),
          new THREE.MeshBasicMaterial({ color: 0xe9bf2e, transparent: true, opacity: 0 }));
        w.position.set(2.4, 0.15, 0.45);
        w.rotation.z = Math.PI * 0.05;
        root.add(w);
        rings.push({ w, start: -10 });
      }

      let pressed = -10, nextPulse = 0;
      function speak(t) {
        pressed = t;
        rings.forEach((r, i) => { r.start = t + i * 0.18; });
      }
      return {
        tap() {
          speak(performance.now() / 1000);
          line = (line + 1) % LINES.length;
          if (bubble) bubble.textContent = `"${LINES[line]}"`;
        },
        update(t) {
          if (!reduce && t > nextPulse) { speak(t); nextPulse = t + 3.5; }
          const p = Math.max(0, 1 - (t - pressed) / 0.35);
          pad.position.y = 0.46 - p * 0.04;
          pad.material.emissiveIntensity = 0.1 + p * 0.6;
          for (const r of rings) {
            const a = (t - r.start) / 1.2;
            r.w.material.opacity = a > 0 && a < 1 ? 0.9 * (1 - a) : 0;
            r.w.scale.setScalar(1 + Math.max(0, a) * 2.2);
          }
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Phone motion: a phone on the table lifts up; gravity stays put, the phone's own "down" tilts
// ---------------------------------------------------------------------------------------------
function motionScene(el) {
  const tag = el.parentElement.querySelector(".tilt-tag");
  stage(el, {
    cam: [0, 3.4, 7], look: [0, 0.6, 0], yaw: 0.55,
    build(root) {
      const table = roundedBox(5, 0.18, 3.2, 0.08, std(0xe8d9b5, { roughness: 0.85 }));
      table.position.y = -0.1;
      root.add(table);

      // The phone, hinged at its bottom edge so it lifts like a real hand picks it up
      const hinge = new THREE.Group();
      hinge.position.set(0, 0.06, 0.95);
      root.add(hinge);
      const phone = roundedBox(1.0, 0.1, 2.0, 0.08, std(INK, { roughness: 0.35 }));
      phone.position.set(0, 0.05, -1.0);
      const camBump = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 20), std(0x444444, { metalness: 0.5 }));
      camBump.position.set(-0.3, 0.11, -1.75);
      hinge.add(phone, camBump);

      // Arrows: gravity (always straight down) and what the phone feels (tilts with it)
      const gravity = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1.7, 2.2, 0), 1.5, 0x5e574b, 0.3, 0.2);
      root.add(gravity);
      // The phone's own "up", sticking out of its back: lined up with gravity while it's flat, tilted when lifted
      const feel = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.12, -1.0), 1.3, 0xe9bf2e, 0.3, 0.2);
      hinge.add(feel);
      const gl = textTexture(256, 64, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = "#5E574B"; g.font = "700 34px system-ui"; g.fillText("gravity", 8, 44); });
      const gLabel = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), new THREE.MeshBasicMaterial({ map: gl.texture, transparent: true }));
      gLabel.position.set(-1.6, 2.5, 0);
      root.add(gLabel);

      let liftAt = 0, cycle = reduce ? 1e9 : 5;
      return {
        tap() { liftAt = performance.now() / 1000; },
        update(t) {
          if (t - liftAt > cycle) liftAt = t;
          const a = t - liftAt;                       // 0-1.2 rest, 1.2-2 up, 2-3.4 held, 3.4-4.2 down
          const up = a < 1.2 ? 0 : a < 2 ? (a - 1.2) / 0.8 : a < 3.4 ? 1 : a < 4.2 ? 1 - (a - 3.4) / 0.8 : 0;
          const ease = up * up * (3 - 2 * up);
          hinge.rotation.x = ease * 0.85;
          hinge.position.y = 0.06 + ease * 0.25;
          gLabel.rotation.set(0, -root.rotation.y, 0);
          if (tag) tag.classList.toggle("up", ease > 0.35);       // ~30° away from flat = a pickup
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Shake: a busted phone on screen, shaken in bursts until the meter fills and it's silenced
// ---------------------------------------------------------------------------------------------
function shakeScene(el) {
  stage(el, {
    cam: [0, 0.6, 7.2], look: [0, 0.2, 0], yaw: 0.35,
    build(root) {
      const phone = new THREE.Group();
      root.add(phone);
      phone.add(roundedBox(1.25, 0.14, 2.5, 0.14, std(INK, { roughness: 0.35 })));
      phone.rotation.x = Math.PI / 2;

      let fill = 0, state = "busted";
      const screen = textTexture(256, 512, (g, w, h) => {
        const done = state === "done";
        g.fillStyle = done ? "#2F8A55" : "#2B2822"; g.fillRect(0, 0, w, h);
        g.fillStyle = "#fff"; g.textAlign = "center";
        g.font = "800 22px system-ui"; g.fillStyle = "#BDB4A0";
        g.fillText(done ? "ALARM OFF" : "PICKUP DETECTED", w / 2, 70);
        g.font = "800 58px system-ui"; g.fillStyle = "#fff";
        g.fillText(done ? "Silenced" : "Busted", w / 2, 250);
        g.font = "700 22px system-ui"; g.fillStyle = "#D8D0BE";
        g.fillText(done ? "Phone down. Good." : "Shake to stop it", w / 2, 300);
        g.fillStyle = "#4A453B"; g.fillRect(40, 360, w - 80, 20);
        g.fillStyle = "#F5D35A"; g.fillRect(40, 360, (w - 80) * fill, 20);
        g.font = "700 22px system-ui"; g.fillStyle = "#D8D0BE";
        g.fillText(`${(fill * 10).toFixed(1)}s / 10s`, w / 2, 420);
      });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2), new THREE.MeshBasicMaterial({ map: screen.texture }));
      face.position.z = 0.081;
      phone.add(face);
      face.rotation.x = -Math.PI / 2;
      face.position.set(0, 0.081, 0);

      // Little motion lines that flash while shaking
      const lines = [];
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: 0xe9bf2e, transparent: true, opacity: 0 }));
        l.position.set(s * (1.05 + i * 0.12), 0.5 - i * 0.45, 0);
        l.rotation.z = s * 0.3;
        root.add(l);
        lines.push(l);
      }

      let burstUntil = 0, nextBurst = 0, doneAt = -10, last = 0;
      return {
        tap() { const t = performance.now() / 1000; if (state === "done") { state = "busted"; fill = 0; } burstUntil = t + 1.2; },
        update(t) {
          const dt = Math.min(0.05, t - last); last = t;
          if (!reduce && t > nextBurst && state === "busted") { burstUntil = t + 1.6; nextBurst = t + 2.4; }
          const shaking = t < burstUntil && state === "busted";
          if (shaking) fill = Math.min(1, fill + dt / 4.5);
          if (fill >= 1 && state === "busted") { state = "done"; doneAt = t; }
          if (state === "done" && t - doneAt > 2.5) { state = "busted"; fill = 0; nextBurst = t + 0.8; }
          const k = shaking ? 1 : 0;
          phone.position.x = k * Math.sin(t * 38) * 0.18;
          phone.rotation.z = k * Math.sin(t * 38 + 1) * 0.12;
          phone.rotation.y = k * Math.sin(t * 29) * 0.15;
          lines.forEach((l, i) => { l.material.opacity = k * (0.5 + 0.5 * Math.sin(t * 30 + i)); });
          screen.redraw();
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------
let webgl = false;
try { webgl = !!document.createElement("canvas").getContext("webgl2"); } catch { /* none */ }
if (webgl) {
  const scenes = { brick: brickScene, motion: motionScene, shake: shakeScene };
  document.querySelectorAll("[data-scene]").forEach(el => scenes[el.dataset.scene]?.(el));
}
