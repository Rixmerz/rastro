// The upload sandbox rule, in one place for the browser engine and the HTTP
// runner: a file may leave the machine only from an allowed directory, with
// symlinks resolved first so a link inside one cannot point back out (S7).

import { realpathSync } from 'node:fs';
import { RastroError } from '../core/types.ts';

export function assertInsideDirs(filePath: string, dirs: string[]): void {
  let real: string;
  try {
    real = realpathSync(filePath);
  } catch {
    throw new RastroError('upload outside allowed dirs', 'open --allow-upload <dir>');
  }
  const allowed = dirs.some((dir) => {
    try {
      const realDir = realpathSync(dir);
      return real === realDir || real.startsWith(`${realDir}/`);
    } catch {
      return false;
    }
  });
  if (!allowed) throw new RastroError('upload outside allowed dirs', 'open --allow-upload <dir>');
}
