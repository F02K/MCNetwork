// Runs under win32-preload.ts and prints what the path functions answer with Windows semantics.
import { resolveConfigured } from '../src/appdir';
import { insideDataDir, resolveServerDir, validateServer } from '../src/config';
import { isAbsolutePath } from '../src/setup/importer';
import type { ServerConfig } from '../src/types';

const DATA = 'C:\\MCNetwork\\data';
const attempt = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return (err as Error).message;
  }
};

console.log(
  JSON.stringify({
    inside: [insideDataDir(DATA, 'servers\\lobby'), insideDataDir(DATA, 'servers/lobby'), insideDataDir(DATA, '..\\other'), insideDataDir(DATA, 'D:\\Minecraft\\x'), insideDataDir(DATA, '.'), insideDataDir(DATA, 'a\\..\\..\\b')],
    dirs: [resolveServerDir(DATA, { dir: 'servers\\lobby' } as ServerConfig), resolveServerDir(DATA, { dir: 'D:\\Minecraft\\survival', external: true } as ServerConfig)],
    absolute: [isAbsolutePath('C:\\Minecraft'), isAbsolutePath('\\\\server\\share\\mc'), isAbsolutePath('relative\\dir'), isAbsolutePath('/unix/style')],
    external: [attempt(() => validateServer({ id: 'old', dir: 'D:\\Minecraft\\old', external: true }, DATA)), attempt(() => validateServer({ id: 'old', dir: 'old', external: true }, DATA)), attempt(() => validateServer({ id: 'old', dir: 'D:\\Minecraft\\..\\x', external: true }, DATA))],
    internal: [validateServer({ id: 'lobby' }, DATA).dir, attempt(() => validateServer({ id: 'lobby', dir: 'D:\\elsewhere' }, DATA))],
    config: [resolveConfigured(DATA, 'C:\\mcli\\mcli.js', ['C:\\app']), resolveConfigured(DATA, 'mcli.js', ['C:\\app'])],
  }),
);
