export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function idleTimeout(env = process.env) {
  const value = env.LCU_IDLE_TIMEOUT_MS;
  if (value === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const ms = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(ms) || ms < 1 || ms > 2 ** 31 - 1) {
    throw new Error('LCU_IDLE_TIMEOUT_MS must be an integer from 1 to 2147483647 milliseconds');
  }
  return ms;
}

/** One runtime generation at a time. Idle release never races a leased operation or its startup. */
export function createRuntimeLifetime(start, { timeout = idleTimeout(), onError = console.error } = {}) {
  let runtime;
  let starting;
  let releasing;
  let closing;
  let stopped = false;
  let timer;
  let busy = 0;
  let drained;
  let resolveDrained;
  let reset = false;
  let releaseError;
  let idleSince;

  async function release(idle = false) {
    const previous = runtime;
    runtime = undefined;
    if (!previous) return;
    reset ||= idle;
    releasing = Promise.resolve().then(() => previous.close());
    try {
      await releasing;
      releaseError = undefined;
    } catch (error) {
      runtime = previous;
      releaseError = error;
      throw error;
    } finally { releasing = undefined; }
  }

  function arm() {
    clearTimeout(timer);
    if (stopped || busy || !runtime || releaseError) return;
    const remaining = Math.max(0, timeout - (Date.now() - idleSince));
    timer = setTimeout(() => { void release(true).catch(onError); }, remaining);
    timer.unref?.();
  }

  return {
    get current() { return runtime; },
    get resetPending() { return reset; },
    acknowledgeReset() { reset = false; },
    async run(operation, { startIfMissing = true, activity = true } = {}) {
      if (stopped) throw new Error('LCU session is shutting down');
      clearTimeout(timer);
      if (busy++ === 0) drained = new Promise(resolve => { resolveDrained = resolve; });
      try {
        await releasing;
        if (releaseError) throw new Error('LCU could not release its previous runtime; restart the session', { cause: releaseError });
        if (!runtime && !starting && !startIfMissing) return;
        if (!runtime && !starting) starting = Promise.resolve().then(start).then(value => {
          runtime = value;
          idleSince = Date.now();
          return value;
        }).finally(() => { starting = undefined; });
        const current = runtime ?? await starting;
        return await operation(current);
      } finally {
        if (activity) idleSince = Date.now();
        if (--busy === 0) resolveDrained();
        arm();
      }
    },
    close() {
      if (closing) return closing;
      stopped = true;
      clearTimeout(timer);
      closing = (async () => {
        if (busy) await drained;
        await releasing;
        await release();
      })();
      return closing;
    },
  };
}
