// Screen-size emulation for a live session: a phone or tablet viewport, with
// the mobile flag, touch and a mobile user agent, applied to every tab of the
// session and kept across new tabs and relaunches.
//
// Applied through CDP rather than Playwright's viewport options: those belong
// to the context, and a persistent context cannot change them without a
// relaunch — which is why people ended up loading the app inside a 390 px
// iframe of the same tab instead.

import type { CDPSession } from 'playwright-core';
import { RastroError } from '../core/types.ts';

export interface Emulation {
  width: number;
  height: number;
  mobile: boolean;
  /** Device pixel ratio; 1 keeps screenshots small. */
  scale: number;
}

const PRESETS: Record<string, Emulation> = {
  mobile: { width: 390, height: 844, mobile: true, scale: 1 },
  tablet: { width: 820, height: 1180, mobile: true, scale: 1 },
};

/** The size headless sessions are created with (see `Session.createContext`). */
export const HEADLESS_DEFAULT = { width: 1280, height: 900 };

/**
 * `390x844`, `mobile`, `tablet` → an emulation; `desktop` / `reset` → null
 * (back to the browser's own size). `mobile` overrides the preset's flag, so
 * `390x844 --mobile` is a phone and `tablet --mobile=false` a narrow desktop.
 */
export function parseViewport(spec: string, opts: { mobile?: boolean; scale?: number } = {}): Emulation | null {
  const key = spec.trim().toLowerCase();
  if (key === 'desktop' || key === 'reset') return null;
  let base: Emulation;
  const preset = PRESETS[key];
  if (preset) {
    base = { ...preset };
  } else {
    const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(key);
    if (!m) throw new RastroError(`bad viewport "${spec}"`, 'use WIDTHxHEIGHT (e.g. 390x844), mobile, tablet or desktop');
    base = { width: Number(m[1]), height: Number(m[2]), mobile: false, scale: 1 };
  }
  if (opts.mobile !== undefined) base.mobile = opts.mobile;
  if (opts.scale !== undefined) {
    if (!(opts.scale > 0 && opts.scale <= 4)) throw new RastroError('--scale must be between 0 and 4');
    base.scale = opts.scale;
  }
  return base;
}

export function describeViewport(e: Emulation | null, headed: boolean): string {
  if (!e) return headed ? 'viewport: window size' : `viewport ${HEADLESS_DEFAULT.width}x${HEADLESS_DEFAULT.height}`;
  return `viewport ${e.width}x${e.height}${e.mobile ? ' mobile' : ''}${e.scale !== 1 ? ` @${e.scale}x` : ''}`;
}

/** A Chrome-on-Android user agent of the same major version as the browser,
 * in the reduced form real Android Chrome sends. */
export function mobileUserAgent(product: string): string {
  const major = /Chrome\/(\d+)/.exec(product)?.[1] ?? '120';
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

/**
 * Applies `e` through `client`, or undoes a previous one when `e` is null.
 * Headless pages go back to the fixed size they were created with; headed
 * ones to the window's own size, where scrollbars stay usable for a human
 * recording. Chromium drops a session's overrides when it detaches, so
 * `client` has to live as long as the page.
 */
export async function applyEmulation(client: CDPSession, e: Emulation | null, headed: boolean): Promise<void> {
  if (e) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: e.width,
      height: e.height,
      deviceScaleFactor: e.scale,
      mobile: e.mobile,
      // Without these, `screen` keeps whatever size Chromium guesses.
      screenWidth: e.width,
      screenHeight: e.height,
    });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: e.mobile, maxTouchPoints: e.mobile ? 5 : 1 });
    if (e.mobile) {
      const { product } = (await client.send('Browser.getVersion')) as { product: string };
      await client.send('Emulation.setUserAgentOverride', { userAgent: mobileUserAgent(product), platform: 'Linux armv8l' });
    } else {
      await client.send('Emulation.setUserAgentOverride', { userAgent: '' });
    }
    return;
  }
  if (headed) {
    await client.send('Emulation.clearDeviceMetricsOverride');
  } else {
    await client.send('Emulation.setDeviceMetricsOverride', {
      ...HEADLESS_DEFAULT,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: HEADLESS_DEFAULT.width,
      screenHeight: HEADLESS_DEFAULT.height,
    });
  }
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await client.send('Emulation.setUserAgentOverride', { userAgent: '' });
}
