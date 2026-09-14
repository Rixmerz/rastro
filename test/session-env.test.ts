import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { browserEnv, Session } from '../src/engine/session.ts';

const hasNvidiaVendor =
  existsSync('/usr/share/glvnd/egl_vendor.d') &&
  readdirSync('/usr/share/glvnd/egl_vendor.d').some((f) => f.includes('nvidia'));

describe('browserEnv', () => {
  test('RASTRO_KEEP_GPU_ENV=1 leaves the environment untouched', () => {
    const env = browserEnv({ RASTRO_KEEP_GPU_ENV: '1', PATH: '/usr/bin' });
    expect(env).toEqual({ RASTRO_KEEP_GPU_ENV: '1', PATH: '/usr/bin' });
  });

  test('explicit user GPU variables win over the override', () => {
    const env = browserEnv({ __EGL_VENDOR_LIBRARY_FILENAMES: '/custom.json', VK_ICD_FILENAMES: '/icd.json', CUDA_VISIBLE_DEVICES: '0' });
    expect(env.__EGL_VENDOR_LIBRARY_FILENAMES).toBe('/custom.json');
    expect(env.VK_ICD_FILENAMES).toBe('/icd.json');
    expect(env.CUDA_VISIBLE_DEVICES).toBe('0');
  });

  test.runIf(hasNvidiaVendor)('hides NVIDIA EGL and Vulkan vendors when they are installed', () => {
    const env = browserEnv({ PATH: '/usr/bin' });
    expect(env.__EGL_VENDOR_LIBRARY_FILENAMES).toBeDefined();
    expect(env.__EGL_VENDOR_LIBRARY_FILENAMES).not.toContain('nvidia');
    expect(env.VK_ICD_FILENAMES ?? '').not.toContain('nvidia');
    expect(env.CUDA_VISIBLE_DEVICES).toBe('');
  });
});

describe('omnibox search engine', () => {
  test('a fresh profile is pointed at DuckDuckGo, and an existing choice is left alone', () => {
    const profile = mkdtempSync(join(tmpdir(), 'rastro-prof-'));
    const prefs = join(profile, 'Default', 'Preferences');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(prefs, JSON.stringify({ some: 'state' }));

    const seed = (Session as unknown as { seedSearchEngine(p: string): void }).seedSearchEngine.bind(Session);

    // Chromium's built-in default is Google, which refuses automated browsers:
    // anything typed in the omnibox becomes a search that lands on a reCAPTCHA
    // no human can clear from this browser.
    seed(profile);
    const after = JSON.parse(readFileSync(prefs, 'utf8')) as {
      some: string;
      default_search_provider_data: { template_url_data: { short_name: string; url: string } };
    };
    expect(after.default_search_provider_data.template_url_data.short_name).toBe('DuckDuckGo');
    expect(after.default_search_provider_data.template_url_data.url).toContain('duckduckgo.com');
    expect(after.some).toBe('state');

    // Whatever the user picked later is theirs to keep.
    writeFileSync(prefs, JSON.stringify({ default_search_provider_data: { template_url_data: { short_name: 'Mine' } } }));
    seed(profile);
    const kept = JSON.parse(readFileSync(prefs, 'utf8')) as {
      default_search_provider_data: { template_url_data: { short_name: string } };
    };
    expect(kept.default_search_provider_data.template_url_data.short_name).toBe('Mine');

    rmSync(profile, { recursive: true, force: true });
  });
});
