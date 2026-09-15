#!/usr/bin/env node
// A published package ships `dist/` and no `src/` (see the `files` field), and
// Node refuses to strip types under node_modules, so an installed copy has to
// reach the compiled entry point. A working clone has `src/` and must run it
// directly, or every edit would need a build to be visible.
import { existsSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

const source = new URL('../src/cli/main.ts', import.meta.url);
await import(existsSync(fileURLToPath(source)) ? source.href : new URL('../dist/cli/main.js', import.meta.url).href);
