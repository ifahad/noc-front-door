const SLOW_MS = 8000;
const DEFAULT_STALL_AFTER = 3;

// Message for a non-2xx edge response: method + path + status only. It must
// never contain request headers, the token or the response body.
export function apiErrorMessage(method, path, status) {
  return `${method} ${path} -> ${status}`;
}

// Which pending pages this prober cycle should try to claim: every page not
// already claimed by this process, one claim per page id even when an id
// repeats, order preserved. Ids in retryIds (a sent-mark that failed earlier)
// are planned even when already claimed, so the mark-sent call is retried on
// the next cycle instead of the page being silently dropped.
export function planPaging(pending, claimedIds, retryIds) {
  const claimed = claimedIds instanceof Set ? claimedIds : new Set(claimedIds ?? []);
  const retry = retryIds instanceof Set ? retryIds : new Set(retryIds ?? []);
  const seen = new Set();
  const plan = [];
  for (const page of Array.isArray(pending) ? pending : []) {
    if (page === null || typeof page !== 'object') continue;
    if (typeof page.id !== 'string' || page.id.length === 0) continue;
    if (typeof page.region !== 'string' || page.region.length === 0) continue;
    if (seen.has(page.id)) continue;
    if (!retry.has(page.id) && claimed.has(page.id)) continue;
    seen.add(page.id);
    plan.push({ region: page.region, pageId: page.id, retry: retry.has(page.id) });
  }
  return plan;
}

// Counts consecutive failed paging cycles and flags a stall once, after
// stallAfter failures in a row; any successful cycle resets the streak.
export function createPagingHealth({ stallAfter = DEFAULT_STALL_AFTER } = {}) {
  if (!Number.isInteger(stallAfter) || stallAfter < 1) {
    throw new Error('stallAfter must be a positive integer');
  }
  let streak = 0;
  return {
    get streak() {
      return streak;
    },
    record(failed) {
      streak = failed === true ? streak + 1 : 0;
      return { stalled: streak === stallAfter, streak };
    },
  };
}

// Verdict for one /ops/health/deep probe. An actor or sync hang means the
// call path is wedged, so the probe fails; a kv-only timeout keeps ok but
// flags degraded. The detail never echoes request or response bodies.
export function classifyProbe(httpOk, body) {
  const timedOut = Array.isArray(body?.timed_out) ? body.timed_out.map(String) : [];
  const hung = timedOut.some((name) => name === 'actor' || name === 'sync');
  const ok = httpOk === true && body?.ok === true && !hung;
  const slow = Array.isArray(body?.slow) ? body.slow.map(String) : [];
  const degraded = body?.degraded === true;
  return {
    ok,
    degraded,
    slow,
    detail: !ok ? (hung ? 'actor timed out' : httpOk ? 'ok:false' : 'http failed') : null,
  };
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
