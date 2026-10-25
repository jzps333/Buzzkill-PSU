/*
  The 3D bee designs. Each one builds a bee facing the camera (+z) and returns its moving parts:
    bee      the whole bee (a THREE.Group)
    wings    [{ pose(flap) }]  flap goes -1..1, many times a second
    eyes     (optional) group that blinks and darts
    smile / gasp / brows   (optional) happy and worried faces
    view     { z, y, lookY, yaw }  where the camera sits; yaw = how far he's turned by default
    profile  true if he looks best from the side (turns to face where he's flying)
*/
import * as THREE from "./vendor/three.module.min.js";

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

function tube(points, radius, material) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => v3(...p)));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 8), material);
}

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Bands from the top of the texture down: [[color, share], ...]
function bands(list, w = 8, h = 512) {
  return canvasTexture(w, h, (g) => {
    let y = 0;
    for (const [color, share] of list) {
      g.fillStyle = color;
      g.fillRect(0, Math.round(y * h), w, Math.ceil(share * h) + 1);
      y += share;
    }
  });
}

// Soft fuzz: tiny speckles so the body reads as furry, not plastic
function fuzz(base, light, dark) {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = Math.random() < 0.5 ? light : dark;
      g.globalAlpha = 0.25 + Math.random() * 0.35;
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, 3);
    }
  });
}

// See-through wing with veins
function veinedWing(rx, ry) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, rx, ry, 0, Math.PI * 2);
  const geo = new THREE.ShapeGeometry(shape, 40);
  geo.translate(rx * 0.92, 0, 0);                  // hinge at the inner end
  // map the ellipse onto the vein texture
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (rx * 1.92), (pos.getY(i) + ry) / (ry * 2));
  const tex = canvasTexture(256, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(230,244,255,0.55)"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(70,55,40,0.55)"; g.lineWidth = 2;
    for (const [y0, y1] of [[0.5, 0.3], [0.5, 0.55], [0.5, 0.8], [0.45, 0.15]]) {
      g.beginPath(); g.moveTo(0, y0 * h); g.quadraticCurveTo(w * 0.5, ((y0 + y1) / 2) * h, w, y1 * h); g.stroke();
    }
    g.beginPath(); g.moveTo(w * 0.45, h * 0.2); g.lineTo(w * 0.55, h * 0.75); g.stroke();
    g.beginPath(); g.moveTo(w * 0.7, h * 0.25); g.lineTo(w * 0.75, h * 0.7); g.stroke();
  });
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const edge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(shape.getPoints(60).map(p => v3(p.x + rx * 0.92, p.y, 0))),
    new THREE.LineBasicMaterial({ color: 0x46372a, transparent: true, opacity: 0.6 }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.add(edge);
  return mesh;
}


// ---------------------------------------------------------------------------------------------
// 1. HONEYBEE: a real honeybee, stylized just enough. Head, fuzzy thorax, striped abdomen,
//    compound eyes, elbowed antennae, six legs, two pairs of veined wings.
// ---------------------------------------------------------------------------------------------
export function honeybee() {
  const bee = new THREE.Group();
  const chitin = new THREE.MeshStandardMaterial({ color: 0x24180f, roughness: 0.45, metalness: 0.1 });

  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.42, 40, 28),
    new THREE.MeshStandardMaterial({ map: fuzz("#B07A28", "#E2B055", "#5A3A14"), roughness: 1 }));
  thorax.scale.set(1, 0.95, 1.05);
  bee.add(thorax);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 32, 24), chitin);
  head.scale.set(1.05, 0.95, 0.85);
  head.position.set(0, -0.04, 0.6);
  bee.add(head);

  // Compound eyes: big, dark and glossy on the sides of the head
  const eyes = new THREE.Group();
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.12, metalness: 0.35 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 18), eyeMat);
    eye.scale.set(0.62, 1.15, 0.95);
    eye.position.set(s * 0.21, 0.0, 0.64);
    eyes.add(eye);
  }
  bee.add(eyes);

  // Elbowed antennae
  for (const s of [-1, 1]) {
    bee.add(tube([[s * 0.07, 0.1, 0.8], [s * 0.1, 0.32, 0.92], [s * 0.16, 0.36, 1.12], [s * 0.2, 0.3, 1.25]], 0.018, chitin));
  }

  // Abdomen: amber and dark rings, pointing back and a little down
  const abdomenGeo = new THREE.SphereGeometry(0.5, 40, 32);
  abdomenGeo.rotateX(Math.PI / 2);                                  // poles front/back, so the bands become rings
  const abdomen = new THREE.Mesh(abdomenGeo, new THREE.MeshStandardMaterial({
    map: bands([["#E3A62C", 0.2], ["#2A1C10", 0.13], ["#E3A62C", 0.13], ["#2A1C10", 0.13], ["#D9982A", 0.12], ["#2A1C10", 0.29]]),
    roughness: 0.75,
  }));
  abdomen.scale.set(0.92, 0.86, 1.32);
  abdomen.position.set(0, -0.14, -0.88);
  abdomen.rotation.x = -0.28;
  bee.add(abdomen);
  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.18, 10), chitin);
  stinger.rotation.x = -Math.PI / 2 - 0.3;
  stinger.position.set(0, -0.33, -1.55);
  bee.add(stinger);

  // Six legs, tucked under while flying
  for (const s of [-1, 1]) {
    for (const [z, back] of [[0.22, 0.1], [0.0, -0.05], [-0.2, -0.35]]) {
      bee.add(tube([[s * 0.18, -0.25, z], [s * 0.36, -0.42, z + 0.02], [s * 0.3, -0.7, z + back]], 0.022, chitin));
    }
  }

  // Wings: a big fore wing and a small hind wing on each side
  const wings = [];
  for (const s of [-1, 1]) {
    for (const [rx, ry, z, sweep] of [[0.78, 0.24, 0.12, 0.55], [0.5, 0.16, -0.12, 0.85]]) {
      const hinge = new THREE.Group();
      hinge.position.set(s * 0.16, 0.33, z);
      const wing = veinedWing(rx, ry);
      wing.scale.x = s;
      hinge.add(wing);
      bee.add(hinge);
      wings.push({ pose: f => hinge.rotation.set(0, s * sweep, s * (0.12 + f * 0.5)) });
    }
  }

  return { bee, wings, eyes, view: { z: 6.4, y: 1.3, lookY: -0.15, yaw: 0.95 }, profile: true };
}


// ---------------------------------------------------------------------------------------------
// 2. SLEEK: a clean, glossy, app-icon bee. One smooth capsule, crisp bands, frosted wings.
// ---------------------------------------------------------------------------------------------
export function sleek() {
  const bee = new THREE.Group();
  const ink = new THREE.MeshPhysicalMaterial({ color: 0x1f1b16, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.15 });

  const bodyGeo = new THREE.CapsuleGeometry(0.62, 0.75, 16, 40);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshPhysicalMaterial({
    map: bands([["#1F1B16", 0.24], ["#F5C431", 0.17], ["#1F1B16", 0.11], ["#F5C431", 0.13], ["#1F1B16", 0.11], ["#F5C431", 0.24]]),
    roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12,
  }));
  body.rotation.x = 0.28;                       // leaning forward, like it's flying somewhere
  bee.add(body);

  // Two small white eyes on the dark "head" band (children of the body, so they lean with it)
  const eyes = new THREE.Group();
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 }));
    eye.scale.set(1, 1.25, 0.5);
    eye.position.set(sx * 0.21, 0.6, 0.52);
    eye.lookAt(sx * 0.8, 0.9, 3);
    eyes.add(eye);
  }
  body.add(eyes);

  // Antennae: straight, thin, round tips
  for (const sx of [-1, 1]) {
    body.add(tube([[sx * 0.1, 0.95, 0.05], [sx * 0.3, 1.38, 0.15]], 0.022, ink));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), ink);
    tip.position.set(sx * 0.31, 1.4, 0.15);
    body.add(tip);
  }

  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 16), ink);
  stinger.position.set(0, -1.07, 0);
  stinger.rotation.x = Math.PI;
  body.add(stinger);

  // Frosted wings
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, 0.62, 0.4, 0, Math.PI * 2);
  const geo = new THREE.ShapeGeometry(shape, 40);
  geo.translate(0.58, 0.18, 0);
  const frost = new THREE.MeshPhysicalMaterial({ color: 0xdcecf7, transparent: true, opacity: 0.6, roughness: 0.15, side: THREE.DoubleSide, depthWrite: false });
  const frostRim = new THREE.LineBasicMaterial({ color: 0x8fb4cc });
  const frostRimGeo = new THREE.BufferGeometry().setFromPoints(shape.getPoints(50).map(p => v3(p.x + 0.58, p.y + 0.18, 0)));
  const wings = [];
  for (const s of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(s * 0.45, 0.5, -0.3);
    const wing = new THREE.Mesh(geo, frost);
    wing.add(new THREE.LineLoop(frostRimGeo, frostRim));
    wing.scale.x = s;
    wing.rotation.z = 0.35 * s;
    hinge.add(wing);
    bee.add(hinge);
    wings.push({ pose: f => hinge.rotation.set(0.15, s * (-0.15 + f * 0.6), 0) });
  }

  return { bee, wings, eyes, view: { z: 8.2, y: 0.4, lookY: 0.05, yaw: 0.35 } };
}


// ---------------------------------------------------------------------------------------------
// 3. CUTE: a softer, simpler mascot. Round head on a round body, big glossy eyes, small smile.
//    No glasses, cap, pencil or cheeks.
// ---------------------------------------------------------------------------------------------
export function cute() {
  const bee = new THREE.Group();
  const ink = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.5 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xffc83a, roughness: 0.55 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.66, 40, 28), new THREE.MeshStandardMaterial({
    map: bands([["#FFC83A", 0.36], ["#241A12", 0.14], ["#FFC83A", 0.12], ["#241A12", 0.14], ["#FFC83A", 0.24]]),
    roughness: 0.55,
  }));
  body.scale.set(1, 0.95, 1);
  body.position.y = -0.45;
  bee.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.56, 40, 28), yellow);
  head.position.set(0, 0.45, 0.1);
  bee.add(head);

  // Big glossy eyes, each with two highlights
  const eyes = new THREE.Group();
  eyes.position.set(0, 0.45, 0.1);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 18), new THREE.MeshStandardMaterial({ color: 0x15100b, roughness: 0.1 }));
    eye.scale.set(0.85, 1.15, 0.6);
    eye.position.set(s * 0.21, 0.04, 0.5);
    const big = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    big.position.set(0.035, 0.05, 0.08);
    const small = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    small.position.set(-0.03, -0.04, 0.08);
    eye.add(big, small);
    eyes.add(eye);
  }
  bee.add(eyes);

  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 8, 20, Math.PI), ink);
  smile.position.set(0, 0.25, 0.64);
  smile.rotation.z = Math.PI;
  const gasp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), ink);
  gasp.scale.set(0.9, 1.1, 0.5);
  gasp.position.set(0, 0.23, 0.64);
  bee.add(smile, gasp);

  for (const s of [-1, 1]) {
    bee.add(tube([[s * 0.15, 0.92, 0.1], [s * 0.22, 1.18, 0.18], [s * 0.36, 1.3, 0.14]], 0.022, ink));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), ink);
    tip.position.set(s * 0.37, 1.31, 0.14);
    bee.add(tip);
  }

  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 14), ink);
  stinger.position.set(0, -1.12, -0.1);
  stinger.rotation.x = Math.PI;
  bee.add(stinger);

  const shape = new THREE.Shape();
  shape.absellipse(0, 0, 0.5, 0.36, 0, Math.PI * 2);
  const geo = new THREE.ShapeGeometry(shape, 40);
  geo.translate(0.46, 0.14, 0);
  const film = new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false });
  const rim = new THREE.LineBasicMaterial({ color: 0x9cc7e4 });
  const rimGeo = new THREE.BufferGeometry().setFromPoints(shape.getPoints(50).map(p => v3(p.x + 0.46, p.y + 0.14, 0)));
  const wings = [];
  for (const s of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(s * 0.42, -0.05, -0.45);
    const wing = new THREE.Mesh(geo, film);
    wing.add(new THREE.LineLoop(rimGeo, rim));
    wing.scale.x = s;
    wing.rotation.z = 0.45 * s;
    hinge.add(wing);
    bee.add(hinge);
    wings.push({ pose: f => hinge.rotation.set(0.15, s * (-0.4 + f * 0.6), 0) });
  }

  return { bee, wings, eyes, smile, gasp, view: { z: 6.6, y: 0.3, lookY: 0.05, yaw: 0.3 } };
}
