import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { browserEnv } from '../src/engine/session.ts';

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
