// Makes `node:path` behave like Windows (backslashes, drive letters) in the process that loads this file, so that
// the path handling of the daemon can be checked on any machine. Used by win32.test.ts.
import Module from 'node:module';
import path from 'node:path';

const patched = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const original = patched._load;
patched._load = function (this: unknown, request: string, ...rest: unknown[]): unknown {
  if (request === 'node:path' || request === 'path') return path.win32;
  return original.call(this, request, ...rest);
};
