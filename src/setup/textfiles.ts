import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** `key=value` files such as server.properties: sets keys, keeps comments, order and unknown keys. */
export function patchProperties(text: string, values: Record<string, string | number | boolean>): string {
  const lines = text.length ? text.split(/\r?\n/) : [];
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = /^([^#=\s][^=]*?)\s*=/.exec(line);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${String(values[m[1]])}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${String(v)}`);
  return out.join('\n') + '\n';
}

export function updateFile(file: string, patch: (text: string) => string): void {
  writeFileSync(file, patch(existsSync(file) ? readFileSync(file, 'utf8') : ''));
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#');

/** YAML scalar for simple values (strings are single-quoted). */
export function yamlScalar(v: string | number | boolean): string {
  return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v);
}

/** Last line of the block that starts at `start` (a key line): up to the next line with less or equal indent. */
function blockEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start]);
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (isContent(lines[i])) {
      if (indentOf(lines[i]) <= base) break;
      end = i + 1;
    }
  }
  return end;
}

/**
 * Sets simple values inside nested YAML mappings, e.g. path ['proxies', 'velocity'] with
 * { enabled: true, secret: 'x' }. Everything else (comments, other keys) stays as it is; missing
 * keys or blocks are added. Works on the plain indentation structure, not on a full YAML parser.
 */
export function patchYamlBlock(text: string, path: string[], values: Record<string, string | number | boolean>): string {
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let start = 0;
  let end = lines.length;
  let indent = 0;
  const step = 2;
  for (const key of path) {
    // children of this region sit at the indent of its first content line (or one step deeper than the parent)
    const first = lines.slice(start, end).find(isContent);
    const childIndent = first ? indentOf(first) : indent;
    let found = -1;
    for (let i = start; i < end; i++) if (indentOf(lines[i]) === childIndent && new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(#.*)?$`).test(lines[i])) {
      found = i;
      break;
    }
    if (found < 0) {
      lines.splice(end, 0, `${' '.repeat(childIndent)}${key}:`);
      found = end;
    }
    start = found + 1;
    end = blockEnd(lines, found);
    if (end < start) end = start;
    indent = childIndent + step;
  }
  const first = lines.slice(start, end).find(isContent);
  const valueIndent = first ? indentOf(first) : indent;
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${' '.repeat(valueIndent)}${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
    let at = -1;
    for (let i = start; i < end; i++) if (re.test(lines[i])) at = i;
    const line = `${' '.repeat(valueIndent)}${k}: ${yamlScalar(v)}`;
    if (at >= 0) lines[at] = line;
    else {
      lines.splice(end, 0, line);
      end++;
    }
  }
  return lines.join('\n') + '\n';
}
