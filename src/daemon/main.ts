// Entry point spawned by the CLI/client: `node src/daemon/main.ts <session>`.
// Loads the engine module (overridable for tests), starts it, and runs the
// daemon until it shuts down.

import { assertSessionName } from '../core/paths.ts';
import { runDaemon } from './server.ts';
import type { Engine } from '../core/types.ts';

interface EngineModule {
  createEngine(session: string): Promise<Engine & { shutdown(): Promise<void> }>;
}

/** `.ts` when this file itself is still source (dev/test), `.js` once built. */
function siblingExt(): string {
  return import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
}

async function loadEngineModule(): Promise<EngineModule> {
  const override = process.env.RASTRO_ENGINE_MODULE;
  const specifier = override ?? new URL(`../engine/engine${siblingExt()}`, import.meta.url).href;
  return (await import(specifier)) as EngineModule;
}

async function main(): Promise<void> {
  const session = process.argv[2];
  if (!session) {
    console.error('usage: rastro-daemon <session>');
    process.exit(2);
  }
  assertSessionName(session);

  const { createEngine } = await loadEngineModule();
  const engine = await createEngine(session);
  await runDaemon(session, engine, {
    onListening: () => process.stdout.write('ready\n'),
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
