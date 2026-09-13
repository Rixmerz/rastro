import { expect, test } from 'vitest';
import { VERSION } from '../src/version.ts';

test('version is defined', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
