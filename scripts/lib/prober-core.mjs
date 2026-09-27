const SLOW_MS = 8000;

// Which pending pages this prober cycle should try to claim: every page not
// already claimed by this process, one claim per page id even when an id
// repeats (an escalation reset can re-mint an id), order preserved.
export function planPaging(pending, claimedIds) {
  const claimed = claimedIds instanceof Set ? claimedIds : new Set(claimedIds ?? []);
  const seen = new Set();
  const plan = [];
  for (const page of Array.isArray(pending) ? pending : []) {
    if (page === null || typeof page !== 'object') continue;
    if (typeof page.id !== 'string' || page.id.length === 0) continue;
    if (typeof page.region !== 'string' || page.region.length === 0) continue;
    if (claimed.has(page.id) || seen.has(page.id)) continue;
    seen.add(page.id);
    plan.push({ region: page.region, pageId: page.id });
  }
  return plan;
}

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
