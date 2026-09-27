const SLOW_MS = 8000;

export function createProber({ failThreshold = 2 } = {}) {
  if (!Number.isInteger(failThreshold) || failThreshold < 1) {
    throw new Error('failThreshold must be a positive integer');
  }
  let failStreak = 0;
  let down = false;
  let degraded = false;

  return {
    get state() {
      return down ? 'down' : degraded ? 'degraded' : 'ok';
    },
    observe({ ok, ms, degraded: slow } = {}) {
      const timedOut = Number.isFinite(ms) && ms > SLOW_MS;
      const failed = ok !== true || timedOut;
      let alert = null;
      if (failed) {
        failStreak += 1;
        if (!down && failStreak >= failThreshold) {
          down = true;
          alert = 'down';
        }
        return { state: this.state, alert };
      }
      failStreak = 0;
      if (down) {
        down = false;
        alert = 'recovered';
      }
      degraded = slow === true;
      return { state: this.state, alert };
    },
  };
}
