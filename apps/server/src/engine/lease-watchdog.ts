/** A stalled database renewal must not keep an executor alive past its lease. */
export function leaseWatchdog(renew: () => Promise<void>, lost: () => void, ttlMs = 15_000, intervalMs = 1_000) {
  let deadline = performance.now() + ttlMs;
  let busy = false;
  let closed = false;
  const fail = () => { if (!closed) { closed = true; clearInterval(timer); lost(); } };
  const timer = setInterval(() => {
    if (closed) return;
    if (performance.now() >= deadline) { fail(); return; }
    if (busy) return;
    busy = true;
    const started = performance.now();
    void renew().then(() => {
      // Measure from request start, never from an arbitrarily delayed response.
      if (!closed) { deadline = started + ttlMs; if (performance.now() >= deadline) fail(); }
    }).catch(fail).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
