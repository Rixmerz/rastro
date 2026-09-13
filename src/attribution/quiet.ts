// Waits for an action to become "quiet": no attributable request pending and
// no DOM mutation for `quietMs`, bounded by `maxWindowMs`. Pure aside from the
// injected clock/poll, so it can be driven by a fake clock in tests.

export interface QuietWaiterInput {
  /** Number of requests currently counted as pending. */
  pending(): number;
  /** Timestamp (ms, same clock as `now`) of the last relevant activity. */
  lastActivity(): number;
  /** Current time in ms. */
  now(): number;
  quietMs: number;
  maxWindowMs: number;
  /** Called between checks; advances the clock in production (a short sleep)
   * or in tests (a fake-clock tick). Defaults to a short real sleep. */
  poll?: () => Promise<void>;
}

const DEFAULT_POLL_MS = 25;

export async function waitForQuiet(
  input: QuietWaiterInput,
): Promise<{ timedOut: boolean; elapsed: number }> {
  const { pending, lastActivity, now, quietMs, maxWindowMs } = input;
  const poll = input.poll ?? (() => new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_MS)));
  const start = now();

  for (;;) {
    if (pending() === 0 && now() - lastActivity() >= quietMs) {
      return { timedOut: false, elapsed: now() - start };
    }
    if (now() - start >= maxWindowMs) {
      return { timedOut: true, elapsed: maxWindowMs };
    }
    await poll();
  }
}
