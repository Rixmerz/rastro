import { expect, test } from 'vitest';
import { VERSION } from '../src/version.js';

test('version is defined', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
