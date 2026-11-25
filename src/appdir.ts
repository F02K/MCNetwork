import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Where the program's own files can be: next to the bundle (a flat release folder) or one level up (dist/ inside the project). */
export const appRoots = (): string[] => [resolve(__dirname), resolve(__dirname, '..')];

/** The first existing file or folder below the app roots, or null. */
export function findApp(...parts: string[]): string | null {
  for (const root of appRoots()) {
    const p = join(root, ...parts);
    if (existsSync(p)) return p;
  }
  return null;
}

/** A path from the configuration: absolute as is, otherwise relative to the data folder, then to the program folder. */
export function resolveConfigured(dataDir: string, value: string, roots: string[] = appRoots()): string {
  if (isAbsolute(value)) return value;
  const candidates = [resolve(dataDir, value), ...roots.map((r) => resolve(r, value))];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}
