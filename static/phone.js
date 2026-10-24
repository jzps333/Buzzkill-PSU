// Buzzkill phone client: detects face-down / pickup / shake and reports to the Pi.

const DEBUG = new URLSearchParams(location.search).has("debug");

// Tuning knobs. If detection feels off on real phones, change these.
const FACE_DOWN = -0.8;    // screen-normal z below this = face-down
const FACE_UP = -0.5;      // above this = picked up
const DOWN_HOLD_MS = 1000; // must stay face-down this long to count
const UP_HOLD_MS = 400;    // must stay up this long to count as a pickup
const SHAKE_FORCE = 14;    // m/s^2 spike that counts as one shake
const SHAKE_PEAKS = 4;     // this many spikes...
const SHAKE_WINDOW_MS = 1500; // ...within this window = a shake

const $ = (s) => document.querySelector(s);
let ws = null;
let myName = null;
let started = false;
let isDown = false;
let wasRoasting = false;
let gotOrientation = false;

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    if (!myName) return;
    send({ type: "join", name: myName });
    if (started) send({ type: "ready", down: isDown });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1000);
}

function handle(msg) {
  if (msg.type === "joined") {
    myName = msg.name;
    try { localStorage.setItem("buzzkill-name", myName); } catch {}
    document.querySelectorAll(".me").forEach((el) => (el.textContent = myName));
    if (!started) show("sensors");
  } else if (msg.type === "error") {
    if (!started) myName = null;
    $("#joinError").textContent = msg.message;
  } else if (msg.type === "state") {
    render(msg);
  }
}

function show(id) {
  for (const s of ["join", "sensors", "game"]) $("#" + s).classList.toggle("hidden", s !== id);
}

// ---------- join ----------

try { $("#name").value = localStorage.getItem("buzzkill-name") || ""; } catch {}
$("#joinBtn").onclick = () => {
  const name = $("#name").value.trim();
  if (!name) return ($("#joinError").textContent = "Enter a name");
  $("#joinError").textContent = "";
  myName = name;
  send({ type: "join", name });
};
$("#name").addEventListener("keydown", (e) => e.key === "Enter" && $("#joinBtn").click());

// ---------- sensors ----------

$("#sensorBtn").onclick = async () => {
  const err = $("#sensorError");
  if (!window.isSecureContext && !DEBUG) {
    err.textContent = "Motion sensors only work over https. Open the https:// link from the README (cloudflared).";
    return;
  }
  // iPhone: must ask inside the tap, both at once so the tap isn't used up.
  const needs = [window.DeviceOrientationEvent, window.DeviceMotionEvent]
    .filter((E) => E && typeof E.requestPermission === "function");
  // Only a hard "denied" stops us; newer Chrome can answer "prompt" and still send events.
  const results = await Promise.all(needs.map((E) => E.requestPermission().catch(() => "error")));
  if (results.includes("denied") && !DEBUG) {
    err.textContent = "Motion access was denied. On iPhone: close Safari fully, reopen this page, and tap Allow.";
    return;
  }
  window.addEventListener("deviceorientation", onOrientation);
  window.addEventListener("devicemotion", onMotion);
  keepAwake();
  started = true;
  send({ type: "ready", down: false });
  show("game");
  setTimeout(() => {
    if (!gotOrientation && !DEBUG) $("#hint").textContent = "No motion sensor detected. Are you on a laptop? Try a phone.";
  }, 2500);
};

let downSince = null;
let upSince = null;

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  gotOrientation = true;
  const rad = Math.PI / 180;
  // z-component of the screen's direction: +1 face-up, -1 face-down
  const nz = Math.cos(e.beta * rad) * Math.cos(e.gamma * rad);
  const now = Date.now();
  if (nz < FACE_DOWN) {
    upSince = null;
    downSince ??= now;
    if (!isDown && now - downSince > DOWN_HOLD_MS) setDown(true);
  } else if (nz > FACE_UP) {
    downSince = null;
    upSince ??= now;
    if (isDown && now - upSince > UP_HOLD_MS) setDown(false);
  }
}

let peaks = [];
let lastPeak = 0;
let lastShake = 0;

function onMotion(e) {
  let force;
  const a = e.acceleration;
  if (a && a.x != null) {
    force = Math.hypot(a.x, a.y, a.z);
  } else {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    force = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
  }
  const now = Date.now();
  if (force < SHAKE_FORCE || now - lastPeak < 120) return;
  lastPeak = now;
  peaks = peaks.filter((t) => now - t < SHAKE_WINDOW_MS);
  peaks.push(now);
  if (peaks.length >= SHAKE_PEAKS && now - lastShake > 2000) {
    lastShake = now;
    peaks = [];
    send({ type: "shake" });
    navigator.vibrate?.(80);
  }
}

function setDown(down) {
  if (down === isDown) return;
  isDown = down;
  send({ type: down ? "putdown" : "pickup" });
  renderStatus();
}

// Leaving the page (switching to Instagram...) counts as a pickup.
document.addEventListener("visibilitychange", () => {
  if (!started) return;
  if (document.hidden) {
    isDown = false;
    downSince = null;
    send({ type: "pickup" });
  } else {
    keepAwake();
  }
});

let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {}
}

// ---------- render ----------

let me = null;

function render(state) {
  me = state.players.find((p) => p.name === myName) || null;
  if (!me || !started) return;
  $("#score").textContent = me.score;
  $("#pickups").textContent = me.pickups;
  const rank = state.players.indexOf(me) + 1;
  $("#rank").textContent = `${rank}/${state.players.length}`;

  const ready = state.players.filter((p) => p.ready && p.connected).length;
  if (state.phase === "lobby") {
    $("#phase").textContent = `Waiting for the host to start. ${ready}/${state.minPlayers} players ready.`;
  } else if (state.phase === "running") {
    const m = Math.floor(state.remaining / 60), s = String(state.remaining % 60).padStart(2, "0");
    $("#phase").textContent = `${m}:${s} left`;
  } else {
    $("#phase").textContent = `Game over! ${state.players[0]?.name} wins.`;
  }

  if (me.roasting && !wasRoasting) navigator.vibrate?.([300, 100, 300]);
  wasRoasting = me.roasting;
  renderStatus();
}

function renderStatus() {
  const card = $("#statusCard");
  const status = $("#status");
  card.classList.toggle("roasted", !!me?.roasting);
  if (me?.roasting) {
    status.textContent = "You're being roasted! SHAKE your phone to stop it.";
    status.className = "big";
  } else if (isDown) {
    status.textContent = "Face-down. Keep studying.";
    status.className = "big status-down";
  } else {
    status.textContent = "Put your phone face-down";
    status.className = "big status-up";
  }
}

// ---------- debug ----------

if (DEBUG) {
  $("#debug").classList.remove("hidden");
  document.querySelectorAll("[data-send]").forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.send;
      if (t === "shake") send({ type: "shake" });
      else setDown(t === "putdown");
    };
  });
}

connect();
