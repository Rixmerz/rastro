import { describe, expect, test } from 'vitest';
import { waitForQuiet } from '../src/attribution/quiet.ts';

/** A fake clock that advances by `stepMs` on every poll. */
function makeClock(stepMs: number): { now: () => number; poll: () => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    poll: () => {
      t += stepMs;
      return Promise.resolve();
    },
  };
}

describe('waitForQuiet', () => {
  test('resolves once the quiet period has elapsed with nothing pending', async () => {
    const clock = makeClock(50);
    const result = await waitForQuiet({
      pending: () => 0,
      lastActivity: () => 0,
      now: clock.now,
      poll: clock.poll,
      quietMs: 200,
      maxWindowMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(200);
    expect(result.elapsed).toBeLessThan(5000);
  });

  test('times out at maxWindowMs when the page never goes quiet', async () => {
    const clock = makeClock(50);
    let lastActivity = 0;
    const result = await waitForQuiet({
      pending: () => 0,
      lastActivity: () => {
        // activity keeps ticking forward with the clock, so it is never
        // quietMs behind "now".
        lastActivity = clock.now();
        return lastActivity;
      },
      now: clock.now,
      poll: clock.poll,
      quietMs: 200,
      maxWindowMs: 1000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.elapsed).toBe(1000);
  });

  test('stays open while a request is pending, then quiets once it clears', async () => {
    const clock = makeClock(50);
    const pendingUntil = 300;
    const result = await waitForQuiet({
      pending: () => (clock.now() < pendingUntil ? 1 : 0),
      lastActivity: () => pendingUntil,
      now: clock.now,
      poll: clock.poll,
      quietMs: 100,
      maxWindowMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    // Quiet can only be reached at or after pendingUntil + quietMs.
    expect(result.elapsed).toBeGreaterThanOrEqual(400);
  });
});
