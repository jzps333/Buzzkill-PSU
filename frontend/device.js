// Is this a phone? Games can only be joined from a phone, because the phone's
// motion sensor is what catches you picking it up.
//
// Two checks:
//   isPhone()          quick check from the browser's description of itself
//   hasMotionSensor()  real check: does the device actually report motion? (laptops don't)
const Device = {
  isPhone() {
    // Chrome / Edge / Android tell us directly
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
      return navigator.userAgentData.mobile;
    }
    // Safari, Firefox: read the browser description
    return /iPhone|iPod|Android.+Mobile|Mobile/i.test(navigator.userAgent);
  },

  // Resolves true if real motion readings arrive within `ms`, false otherwise.
  // On iPhone, call this from a button tap after asking for motion permission.
  hasMotionSensor(ms = 2500) {
    return new Promise(resolve => {
      const done = ok => { window.removeEventListener("devicemotion", onMove); clearTimeout(timer); resolve(ok); };
      const onMove = e => {
        const g = e.accelerationIncludingGravity;
        if (g && g.x !== null && g.y !== null && g.z !== null) done(true);
      };
      const timer = setTimeout(() => done(false), ms);
      window.addEventListener("devicemotion", onMove);
    });
  },
};
