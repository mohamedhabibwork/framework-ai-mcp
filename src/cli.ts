import { existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { frameworkCommands, type ProjectAdapter, runCli } from '@framework/cli';

/** Commands that never terminate on their own; they are processes, not operations. */
const LONG_RUNNING_COMMANDS = new Set(['serve', 'dev', 'queue:work', 'schedule:work']);

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9:_-]*$/;

const DEFAULT_TIMEOUT_MS = 120_000;

export interface CliResult {
  readonly command: string;
  readonly exitCode: number;
  readonly envelope: Record<string, unknown> | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface FrameworkPaths {
  readonly root: string;
  readonly appDir: string;
  readonly cliEntry: string;
}

function findWorkspaceRoot(startDir: string): string {
  const configured = process.env.FRAMEWORK_ROOT;
  if (configured) return resolve(configured);
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, 'packages', 'cli'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) throw new Error('FRAMEWORK_ROOT is not set and no workspace root could be located');
    current = parent;
  }
}

export function frameworkPaths(): FrameworkPaths {
  const root = findWorkspaceRoot(import.meta.dir);
  const appDir = resolve(root, normalize(process.env.FRAMEWORK_APP_DIR ?? 'apps/playground'));
  const cliEntry = join(appDir, 'bin', 'cli.ts');
  if (!existsSync(cliEntry)) {
    throw new Error(`No CLI entry at ${cliEntry} (set FRAMEWORK_APP_DIR to a generated app directory)`);
  }
  return { root, appDir, cliEntry };
}

export function assertRunnableCommand(command: string): void {
  if (!COMMAND_NAME_PATTERN.test(command)) {
    throw new Error(`Invalid command name "${command}"`);
  }
  if (LONG_RUNNING_COMMANDS.has(command)) {
    throw new Error(
      `"${command}" is a long-running process and cannot be executed as a tool call. ` +
        'Start it in a terminal instead (e.g. `bun run cli -- serve`).',
    );
  }
}

interface AppCliModule {
  readonly project: ProjectAdapter;
}

let appCliModule: Promise<AppCliModule> | undefined;

/** Imports the application CLI entry once; the adapter carries the app's own wiring. */
function loadAppCli(): Promise<AppCliModule> {
  appCliModule ??= (async () => {
    const { cliEntry } = frameworkPaths();
    const mod = (await import(cliEntry)) as Partial<AppCliModule> | undefined;
    if (!mod || typeof mod !== 'object' || !mod.project) {
      throw new Error(`${cliEntry} does not export a "project" adapter; regenerate the app or update bin/cli.ts`);
    }
    return { project: mod.project };
  })();
  return appCliModule;
}

/** The MCP server reports the application's framework version, not a literal. */
export async function frameworkVersion(): Promise<string> {
  const { project } = await loadAppCli();
  return project.frameworkVersion;
}

/**
 * CLI invocations mutate shared singletons; run them strictly one at a time.
 * Known limitation: a timed-out invocation cannot be cancelled in-process, so
 * the queue stays blocked until the abandoned run settles.
 */
let invocationQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = invocationQueue.then(task, task);
  invocationQueue = next.catch(() => undefined);
  return next;
}

/** Per-invocation timeout in ms (FRAMEWORK_MCP_TIMEOUT_MS, default 120000). */
export function timeoutMs(): number {
  const raw = Number(process.env.FRAMEWORK_MCP_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Runs one application CLI command in-process through the embeddable `runCli`
 * API — no child process, no shell. The machine-readable `--json` envelope and
 * `--no-interaction` are always enabled so tool calls never prompt and every
 * response is stable, redacted output.
 */
export async function runCliCommand(command: string, args: readonly string[] = []): Promise<CliResult> {
  assertRunnableCommand(command);
  if (args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) {
    throw new Error('CLI arguments must be plain strings');
  }

  return serialized(async () => {
    const { project } = await loadAppCli();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const invocation = runCli({
      argv: [command, ...args, '--json', '--no-interaction'],
      project,
      commands: frameworkCommands,
      cliVersion: project.frameworkVersion,
      stdout: (text) => stdoutChunks.push(text),
      stderr: (text) => stderrChunks.push(text),
      isTTY: false,
    });

    // An in-process invocation cannot be cancelled; on timeout the call
    // reports 124 while the underlying command is left to finish on its own.
    const result = await Promise.race([
      invocation.then((exitCode) => ({ exitCode, timedOut: false })),
      new Promise<{ exitCode: number; timedOut: true }>((resolveTimeout) =>
        setTimeout(() => resolveTimeout({ exitCode: 124, timedOut: true }), timeoutMs()),
      ),
    ]);

    const stdout = stdoutChunks.join('\n');
    const stderr = stderrChunks.join('\n');
    let envelope: Record<string, unknown> | null = null;
    const trimmed = stdout.trim();
    if (trimmed.startsWith('{')) {
      try {
        envelope = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        envelope = null;
      }
    }

    return { command, exitCode: result.exitCode, envelope, stdout, stderr, timedOut: result.timedOut };
  });
}
