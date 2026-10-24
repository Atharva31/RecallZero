// Shared helpers for scripts/: env, gateway client, spacetime CLI, polling, checks.
// No dependencies beyond Node (>= 23.6, runs .ts natively).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ErrorBody } from '../shared/contracts/gateway.ts';
import type { InventoryBalance } from '../shared/contracts/tables.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Root .env (optional). Values already in the environment win.
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env */
}

export const GATEWAY_URL = (process.env.GATEWAY_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const DB_NAME = process.env.SPACETIMEDB_DB ?? 'recallzero';
export const SERVER = process.env.SPACETIMEDB_SERVER ?? 'local';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const args = new Set(process.argv.slice(2));
/** `--name value` from argv. */
export function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------- Output ----------

const tty = process.stdout.isTTY;
const color = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = color(32);
export const red = color(31);
export const amber = color(33);
export const dim = color(2);
export const bold = color(1);

export const step = (msg: string) => console.log(`\n${bold('▶')} ${bold(msg)}`);
export const info = (msg: string) => console.log(`  ${dim(msg)}`);
export const pass = (msg: string) => console.log(`  ${green('✔')} ${msg}`);

export class CheckError extends Error {}

/** Throws CheckError (stops the script) when `ok` is false. */
export function check(ok: unknown, msg: string, detail?: unknown): asserts ok {
  if (!ok) {
    console.log(`  ${red('✘')} ${msg}`);
    if (detail !== undefined) console.log(dim(`    ${JSON.stringify(detail)}`));
    throw new CheckError(msg);
  }
  pass(msg);
}

export const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ---------- spacetime CLI ----------

/** `spacetime` from PATH, $SPACETIME_BIN, or the installer's ~/.local/bin. */
export function spacetimeBin(): string {
  if (process.env.SPACETIME_BIN) return process.env.SPACETIME_BIN;
  const local = join(homedir(), '.local', 'bin', 'spacetime');
  const onPath = spawnSync('spacetime', ['--version'], { stdio: 'ignore' }).status === 0;
  return onPath || !existsSync(local) ? 'spacetime' : local;
}

/** Runs the spacetime CLI; throws with its output on failure. */
export function spacetime(cliArgs: string[], opts: { cwd?: string } = {}): string {
  const r = spawnSync(spacetimeBin(), cliArgs, { cwd: opts.cwd ?? ROOT, encoding: 'utf8' });
  if (r.error) throw new Error(`spacetime CLI not found (${r.error.message}). Install it or set SPACETIME_BIN.`);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) throw new Error(`spacetime ${cliArgs.join(' ')} failed:\n${out}`);
  return out;
}

export function serverOnline(): boolean {
  try {
    return /online/i.test(spacetime(['server', 'ping', SERVER]));
  } catch {
    return false;
  }
}

/** seed_fixtures as the CLI identity (the publisher is the module admin). */
export function seedFixtures() {
  try {
    spacetime(['call', DB_NAME, 'seed_fixtures', '--server', SERVER]);
  } catch (e) {
    const msg = (e as Error).message;
    if (/UNAUTHORIZED/.test(msg)) {
      throw new Error(`${msg}\nThis CLI identity is not the module admin. Republish with: node scripts/reset.ts --hard`);
    }
    throw e;
  }
}

/** Row count of a table via `spacetime sql` (no gateway needed). */
export function countRows(table: string): number {
  const out = spacetime(['sql', DB_NAME, `SELECT COUNT(*) AS n FROM ${table}`, '--server', SERVER]);
  const m = /-+\s*\n\s*(\d+)/.exec(out);
  if (!m) throw new Error(`could not parse row count for ${table}:\n${out}`);
  return Number(m[1]);
}

/** Wipes the database and republishes the module; the CLI identity becomes admin. */
export function publishReset() {
  spacetime(['publish', DB_NAME, '--server', SERVER, '--delete-data=always', '--yes'], { cwd: join(ROOT, 'spacetimedb') });
}

// ---------- Gateway ----------

export interface GwResult<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  body: ({ ok: true } & T) | ErrorBody;
}

export async function gw<T = any>(
  method: 'GET' | 'POST',
  path: string,
  orgId?: string,
  body?: unknown
): Promise<GwResult<T>> {
  const headers: Record<string, string> = {};
  if (orgId) headers['X-Org-Id'] = orgId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as GwResult<T>['body'];
  return { status: res.status, ok: res.ok && json.ok, body: json };
}

/** Like gw() but throws on any failure; returns the success body. */
export async function gwOk<T = any>(method: 'GET' | 'POST', path: string, orgId?: string, body?: unknown) {
  const r = await gw<T>(method, path, orgId, body);
  if (!r.body.ok) {
    throw new CheckError(`${method} ${path} as ${orgId ?? '-'} -> ${r.status} ${r.body.error.code}: ${r.body.error.message}`);
  }
  return r.body as { ok: true } & T;
}

export async function gatewayHealth(): Promise<{ spacetimedb: string; orgs: string[] } | null> {
  try {
    const r = await gw<{ spacetimedb: string; orgs: string[] }>('GET', '/health');
    return r.body.ok ? r.body : null;
  } catch {
    return null;
  }
}

/** Polls `fn` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 1_000, onTick }: { timeoutMs?: number; intervalMs?: number; onTick?: () => void } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new CheckError(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    onTick?.();
    await sleep(intervalMs);
  }
}

/** True if something is listening on localhost:port (used to detect running agents). */
export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ port, host });
    s.setTimeout(500);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });
}

// ---------- Fixtures ----------

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, 'fixtures', `${name}.json`), 'utf8')) as T;
}

/** Seeded balances per location (fixtures/inventory_balances.json). */
export function seededBalances(): Map<string, InventoryBalance[]> {
  const byLocation = new Map<string, InventoryBalance[]>();
  for (const b of fixture<InventoryBalance[]>('inventory_balances')) {
    byLocation.set(b.locationId, [...(byLocation.get(b.locationId) ?? []), b]);
  }
  return byLocation;
}
