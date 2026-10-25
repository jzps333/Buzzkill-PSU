/*
  Buzz the bee + the 10-second shake meter.
  Used by index.html (demo) and join.html (the real game).

  Buzz.bee(el, mood)          draw Buzz inside el. mood: "happy" or "worried"
  Buzz.setMood(el, mood)      change his face
  Buzz.bounce(beeEl, boxEl)   fling Buzz to a random spot inside boxEl (call on every shake)
  Buzz.home(beeEl)            send Buzz back to the middle
  Buzz.listenForShakes(fn)    calls fn() on every hard shake of the phone. Returns a stop function.
  Buzz.meter({...})           counts seconds of ACTIVE shaking (pauses when you stop)
*/
(function () {
  const INK = "#2B2118";

  const SVG = `
<svg class="bz-svg" viewBox="0 0 210 215" role="img" aria-label="Buzz the bee">
  <defs>
    <clipPath id="bz-body-clip"><ellipse cx="100" cy="137" rx="62" ry="65"/></clipPath>
  </defs>

  <!-- feet -->
  <ellipse cx="80" cy="203" rx="12" ry="7" fill="${INK}"/>
  <ellipse cx="120" cy="203" rx="12" ry="7" fill="${INK}"/>

  <!-- wings -->
  <g class="bz-wing bz-wing-l">
    <ellipse cx="48" cy="96" rx="32" ry="21" transform="rotate(-32 48 96)" fill="#E3F4FF" stroke="${INK}" stroke-width="4.5"/>
    <path d="M36 92 Q48 88 60 98" stroke="#B9DDF4" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>
  <g class="bz-wing bz-wing-r">
    <ellipse cx="152" cy="96" rx="32" ry="21" transform="rotate(32 152 96)" fill="#E3F4FF" stroke="${INK}" stroke-width="4.5"/>
    <path d="M164 92 Q152 88 140 98" stroke="#B9DDF4" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>

  <!-- antennae (behind the cap) -->
  <path d="M90 74 Q84 50 74 34" stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <path d="M110 74 Q116 50 126 34" stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <circle cx="73" cy="31" r="6.5" fill="${INK}"/>
  <circle cx="127" cy="31" r="6.5" fill="${INK}"/>

  <!-- body -->
  <ellipse cx="100" cy="137" rx="62" ry="65" fill="#FFC93C"/>
  <g clip-path="url(#bz-body-clip)">
    <rect x="30" y="156" width="140" height="16" fill="${INK}"/>
    <rect x="30" y="184" width="140" height="16" fill="${INK}"/>
    <ellipse cx="78" cy="98" rx="30" ry="14" fill="#FFE08A" opacity=".7"/>
  </g>
  <ellipse cx="100" cy="137" rx="62" ry="65" fill="none" stroke="${INK}" stroke-width="5"/>

  <!-- arms: left waves, right holds a pencil -->
  <path d="M42 150 Q26 146 22 128" stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="22" cy="125" r="6" fill="${INK}"/>
  <g transform="rotate(22 180 132)">
    <rect x="173" y="96" width="14" height="48" rx="2" fill="#FFD25A" stroke="${INK}" stroke-width="3.5"/>
    <rect x="173" y="91" width="14" height="10" rx="2" fill="#FF8FA3" stroke="${INK}" stroke-width="3.5"/>
    <path d="M173 144 L180 159 L187 144 Z" fill="#F6D7B0" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M178 154.5 L180 159 L182 154.5 Z" fill="${INK}"/>
  </g>
  <path d="M158 152 Q170 150 176 140" stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="176" cy="138" r="6" fill="${INK}"/>

  <!-- graduation cap -->
  <rect x="76" y="61" width="48" height="15" rx="4" fill="${INK}"/>
  <polygon points="100,44 148,58 100,72 52,58" fill="${INK}"/>
  <polygon points="100,48 138,58.5 100,68" fill="#3E3226"/>
  <path d="M100 58 Q124 60 138 62 L140 80" stroke="#FFC93C" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M136 79 L144 79 L142 90 L138 90 Z" fill="#FFC93C" stroke="${INK}" stroke-width="2"/>

  <!-- glasses -->
  <path d="M59 110 L44 106 M141 110 L156 106" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="79" cy="113" r="19" fill="#FFFFFF" fill-opacity=".6" stroke="${INK}" stroke-width="5"/>
  <circle cx="121" cy="113" r="19" fill="#FFFFFF" fill-opacity=".6" stroke="${INK}" stroke-width="5"/>
  <path d="M97.5 110 Q100 106 102.5 110" stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"/>

  <!-- eyes -->
  <g class="bz-eyes">
    <circle cx="81" cy="115" r="7.5" fill="${INK}"/>
    <circle cx="119" cy="115" r="7.5" fill="${INK}"/>
    <circle cx="83.5" cy="112" r="2.6" fill="#fff"/>
    <circle cx="121.5" cy="112" r="2.6" fill="#fff"/>
  </g>

  <!-- cheeks -->
  <ellipse cx="61" cy="134" rx="8" ry="5" fill="#FF9AAE" opacity=".85"/>
  <ellipse cx="139" cy="134" rx="8" ry="5" fill="#FF9AAE" opacity=".85"/>

  <!-- mouths -->
  <path class="bz-happy" d="M90 136 Q100 146 110 136" stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <ellipse class="bz-worried" cx="100" cy="142" rx="6" ry="7.5" fill="${INK}"/>
  <path class="bz-worried" d="M66 90 L78 86 M134 90 L122 86" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
</svg>`;

  const CSS = `
.bz-bee { display: inline-block; will-change: transform; }
.bz-svg { display: block; width: 100%; height: auto; overflow: visible; }
.bz-bee .bz-worried { display: none; }
.bz-bee.bz-mood-worried .bz-happy { display: none; }
.bz-bee.bz-mood-worried .bz-worried { display: inline; }
.bz-wing { transform-box: fill-box; }
.bz-wing-l { transform-origin: 100% 100%; }
.bz-wing-r { transform-origin: 0% 100%; }
.bz-float .bz-svg { animation: bz-float 3.2s ease-in-out infinite; }
.bz-float .bz-wing-l { animation: bz-flap-l .5s ease-in-out infinite; }
.bz-float .bz-wing-r { animation: bz-flap-r .5s ease-in-out infinite; }
.bz-bee.bz-panic .bz-wing-l { animation: bz-flap-l .09s linear infinite; }
.bz-bee.bz-panic .bz-wing-r { animation: bz-flap-r .09s linear infinite; }
@keyframes bz-float { 50% { transform: translateY(-8px); } }
@keyframes bz-flap-l { 50% { transform: rotate(-14deg); } }
@keyframes bz-flap-r { 50% { transform: rotate(14deg); } }
.bz-bouncing { transition: transform .22s cubic-bezier(.25, 1.7, .45, 1); }
@media (prefers-reduced-motion: reduce) {
  .bz-float .bz-svg, .bz-float .bz-wing-l, .bz-float .bz-wing-r,
  .bz-bee.bz-panic .bz-wing-l, .bz-bee.bz-panic .bz-wing-r { animation: none; }
  .bz-bouncing { transition: transform .05s linear; }
}`;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  function bee(el, mood = "happy") {
    el.classList.add("bz-bee");
    el.innerHTML = SVG;
    setMood(el, mood);
  }

  function setMood(el, mood) {
    el.classList.toggle("bz-mood-worried", mood === "worried");
  }

  // Fling Buzz somewhere new inside the box, with a spin and a squish
  let lastX = 0;
  function bounce(beeEl, boxEl) {
    const box = boxEl.getBoundingClientRect();
    const b = beeEl.getBoundingClientRect();
    const maxX = Math.max(0, (box.width - b.width) / 2 - 8);
    const maxY = Math.max(0, (box.height - b.height) / 2 - 8);
    // always jump to the other side so every shake is visible
    const side = lastX > 0 ? -1 : 1;
    const x = side * (0.35 + Math.random() * 0.65) * maxX;
    const y = (Math.random() * 2 - 1) * maxY;
    const r = (Math.random() * 2 - 1) * 30;
    const s = 0.9 + Math.random() * 0.2;
    lastX = x;
    beeEl.classList.add("bz-bouncing");
    beeEl.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) rotate(${r.toFixed(0)}deg) scale(${s.toFixed(2)})`;
  }

  function home(beeEl) {
    beeEl.classList.add("bz-bouncing");
    beeEl.style.transform = "translate(0, 0) rotate(0) scale(1)";
    lastX = 0;
  }

  // Hard jolts of the phone. One jolt = one call, even though the sensor fires ~60x a second.
  function listenForShakes(fn, threshold = 13) {
    let last = 0;
    function onMotion(e) {
      const a = e.acceleration;
      const g = e.accelerationIncludingGravity;
      let strength = 0;
      if (a && a.x != null) strength = Math.hypot(a.x, a.y, a.z);
      else if (g && g.x != null) strength = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.8);
      const now = performance.now();
      if (strength > threshold && now - last > 110) { last = now; fn(); }
    }
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }

  /*
    Seconds of active shaking. Time only counts while shakes keep coming
    (within `graceMs` of the last one), so stopping pauses the clock.
      seconds   total needed (default 10)
      tickMs    onTick() fires once per this much shaking (default 500 → 20 ticks)
      onProgress(fraction, ms)
      onDone()
  */
  function meter({ seconds = 10, tickMs = 500, graceMs = 400, onProgress = () => {}, onTick = () => {}, onDone = () => {} } = {}) {
    let total = seconds * 1000;
    let elapsed = 0, ticks = 0, lastJolt = -1e9, lastFrame = null, raf = null, done = false;

    function frame(now) {
      if (lastFrame !== null && now - lastJolt < graceMs) {
        elapsed = Math.min(total, elapsed + (now - lastFrame));
        while (ticks < Math.floor(elapsed / tickMs)) { ticks++; onTick(ticks); }
        onProgress(elapsed / total, elapsed);
        if (elapsed >= total && !done) { done = true; stop(); onDone(); return; }
      }
      lastFrame = now;
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf && !done) { lastFrame = null; raf = requestAnimationFrame(frame); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = null; }
    function jolt() { lastJolt = performance.now(); }
    function reset() { stop(); elapsed = 0; ticks = 0; done = false; onProgress(0, 0); }
    // keep in step with the database if it has counted more than we have
    function sync(ms) { if (ms > elapsed) { elapsed = Math.min(total, ms); ticks = Math.floor(elapsed / tickMs); onProgress(elapsed / total, elapsed); } }
    function isShaking() { return performance.now() - lastJolt < graceMs; }

    // change how long it takes (e.g. the database says 10s, or 30s on a later pickup)
    function setSeconds(n) { total = Math.max(1, n) * 1000; onProgress(Math.min(1, elapsed / total), elapsed); }

    return { start, stop, jolt, reset, sync, setSeconds, isShaking, get elapsed() { return elapsed; }, get total() { return total; } };
  }

  window.Buzz = { bee, setMood, bounce, home, listenForShakes, meter };
})();
