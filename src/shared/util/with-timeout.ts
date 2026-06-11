// Timeout wrapper that actually cancels the underlying work via
// AbortSignal. `Promise.race(timeout)` alone leaks the original
// promise / connection — the fetch keeps going in the background
// even after the race rejects. This wrapper creates the controller
// before the factory runs, hands the signal to the factory, and
// always clears the timer in `finally`.
//
// Caller distinguishes timeout from other errors via the conventional
// `error.name === "AbortError"` check.

export async function withTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await factory(ctrl.signal)
  } finally {
    clearTimeout(timer)
  }
}
