// Run the jev CLI as a subprocess: a clean env (no keys unless given) and a `jev` first on PATH for scripts.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const scratch = () => mkdtempSync(join(tmpdir(), 'jev-test-'));
const bin = scratch(),
  JEV = join(bin, 'jev');
writeFileSync(JEV, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, '../src/jev.ts')}" "$@"\n`);
chmodSync(JEV, 0o755);

export async function sh(
  command: string[],
  { stdin = '', env = {} }: { stdin?: string; env?: Record<string, string> } = {},
) {
  const p = Bun.spawn(command, {
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '', ...env },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
export const jev = (args: string[], options?: Parameters<typeof sh>[1]) => sh([JEV, ...args], options);
/** The effects a `jev record` tape holds (none if nothing was recorded). */
export const tape = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
