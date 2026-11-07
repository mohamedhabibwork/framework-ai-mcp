import { type CliResult, runCliCommand } from './cli';
import { listDocs, readDoc, searchDocs } from './docs';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const BANNED_GLOBAL_FLAGS = new Set(['--json', '--no-interaction', '-h', '--help', '--version', '-V']);

function option(args: Record<string, unknown>, name: string, flag: string): string[] {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') return [];
  return [flag, value.trim()];
}

function positional(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') return [];
  return [value.trim()];
}

function booleanOption(args: Record<string, unknown>, name: string, flag: string): string[] {
  return args[name] === true ? [flag] : [];
}

function numberOption(args: Record<string, unknown>, name: string, flag: string): string[] {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) return [];
  return [flag, String(Math.trunc(value))];
}

function enumOption(args: Record<string, unknown>, name: string, flag: string, allowed: readonly string[]): string[] {
  const value = args[name];
  if (typeof value !== 'string' || !allowed.includes(value)) return [];
  return [flag, value];
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

const stringProperty = (description: string): Record<string, unknown> => ({ type: 'string', description });

function renderCliResult(result: CliResult): string {
  const envelope = result.envelope ?? {
    command: result.command,
    status: result.exitCode === 0 ? 'ok' : 'error',
    data: { stdout: result.stdout, stderr: result.stderr },
    warnings: [],
  };
  return JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, envelope }, null, 2);
}

async function cli(command: string, buildArgs: () => string[]): Promise<string> {
  return renderCliResult(await runCliCommand(command, buildArgs()));
}

const ACCESS_VALUES = ['public', 'authenticated'] as const;
const TEST_MODE_VALUES = ['in-process', 'network'] as const;
const CHECK_KINDS = ['typecheck', 'lint', 'test', 'format'] as const;

export const toolSpecs: readonly ToolSpec[] = [
  {
    name: 'catalog',
    description:
      'List every CLI command of the hono-framework application with implemented/planned/validated status. ' +
      'Run this first to discover what the target app supports.',
    inputSchema: objectSchema({}),
    handler: () => cli('list', () => []),
  },
  {
    name: 'help',
    description: 'Usage, arguments, options, examples and capability requirements for one CLI command.',
    inputSchema: objectSchema({ command: stringProperty('CLI command name, e.g. make:crud') }, ['command']),
    handler: (args) => cli('help', () => positional(args, 'command')),
  },
  {
    name: 'run_command',
    description:
      'Run any implemented app CLI command with raw arguments. Prefer the structured tools ' +
      '(db_migrate, crud_scaffold, queue_status, …) when one exists. Long-running processes ' +
      '(serve, dev, queue:work, schedule:work) are rejected. Global flags are supplied automatically.',
    inputSchema: objectSchema({
      command: stringProperty('CLI command name, e.g. db:status'),
      args: { type: 'array', items: { type: 'string' }, description: 'Additional CLI arguments' },
    }),
    handler: (args) => {
      const command = String(args.command ?? '');
      const extra = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
      return cli(command, () => extra.filter((arg) => !BANNED_GLOBAL_FLAGS.has(arg)));
    },
  },
  {
    name: 'doctor',
    description: 'Validate application configuration and optionally probe database connectivity.',
    inputSchema: objectSchema({ connections: { type: 'boolean', description: 'Probe database connectivity' } }),
    handler: (args) => cli('doctor', () => booleanOption(args, 'connections', '--connections')),
  },
  {
    name: 'routes_list',
    description: 'The registered route table (method, path, handler count). Opens no connections.',
    inputSchema: objectSchema({
      method: stringProperty('Filter by HTTP method'),
      path: stringProperty('Filter by path fragment'),
    }),
    handler: (args) =>
      cli('route:list', () => [...option(args, 'method', '--method'), ...option(args, 'path', '--path')]),
  },
  {
    name: 'modules_list',
    description: 'Registered providers, middleware aliases and middleware groups.',
    inputSchema: objectSchema({}),
    handler: () => cli('module:list', () => []),
  },
  {
    name: 'config_check',
    description: 'Validate the resolved application configuration without starting anything.',
    inputSchema: objectSchema({}),
    handler: () => cli('config:check', () => []),
  },
  {
    name: 'config_show',
    description: 'Show resolved configuration with secrets redacted. Without a key, the whole tree.',
    inputSchema: objectSchema({ key: stringProperty('Configuration key, e.g. database.url') }),
    handler: (args) => cli('config:show', () => positional(args, 'key')),
  },
  {
    name: 'db_status',
    description: 'Applied and pending migration state. Read-only.',
    inputSchema: objectSchema({}),
    handler: () => cli('db:status', () => []),
  },
  {
    name: 'db_generate',
    description:
      'Diff the Drizzle schema and generate a migration (offline, pinned Drizzle Kit). Review the SQL afterwards; ' +
      'nothing is applied until db_migrate runs.',
    inputSchema: objectSchema({ name: stringProperty('Migration name') }, ['name']),
    handler: (args) => cli('db:generate', () => option(args, 'name', '--name')),
  },
  {
    name: 'db_migrate',
    description:
      'Apply pending migrations under a lock. Migrations are never applied automatically on startup — ' +
      'this (or a release pipeline) is the explicit step.',
    inputSchema: objectSchema({ connection: stringProperty('Named connection override') }),
    handler: (args) => cli('db:migrate', () => option(args, 'connection', '--connection')),
  },
  {
    name: 'crud_scaffold',
    description:
      'One-command CRUD: generates the Drizzle table + migration, Drizzle–Zod schemas, DTOs, form requests, ' +
      'repository, service, controller, policy, typed Hono routes, OpenAPI operations, fixtures and an endpoint ' +
      'test suite, then registers everything. Either fields (new table) or table (existing export) is required. ' +
      'Use dryRun first to preview.',
    inputSchema: objectSchema(
      {
        resource: stringProperty('PascalCase resource name, e.g. Category'),
        module: stringProperty('Destination module (default: resource plural)'),
        fields: stringProperty(
          "Field spec for a new table: 'name:type:modifier,…' with types text|integer|numeric|boolean|uuid|timestamp " +
            'and modifiers required|nullable|default=<literal>',
        ),
        table: stringProperty('Existing Drizzle table export name (mutually exclusive with fields)'),
        schemaFile: stringProperty('Where table is exported (default: schema index)'),
        definition: stringProperty('JSON resource definition path for enums/relations/exposure/fixtures'),
        route: stringProperty('Mount path (default /api/v1/<module>)'),
        access: { type: 'string', enum: [...ACCESS_VALUES], description: 'Required by the CLI' },
        softDelete: { type: 'boolean', description: 'Add deletedAt + restore behavior and tests' },
        verify: { type: 'boolean', description: 'Typecheck + run the endpoint suite on an isolated database' },
        testMode: { type: 'string', enum: [...TEST_MODE_VALUES], description: 'Endpoint transport for verify' },
        dryRun: { type: 'boolean', description: 'Preview every file change; write nothing' },
        force: { type: 'boolean', description: 'Overwrite generator-owned files of this module only' },
      },
      ['resource'],
    ),
    handler: (args) =>
      cli('make:crud', () => [
        ...positional(args, 'resource'),
        ...option(args, 'module', '--module'),
        ...option(args, 'fields', '--fields'),
        ...option(args, 'table', '--table'),
        ...option(args, 'schemaFile', '--schema-file'),
        ...option(args, 'definition', '--definition'),
        ...option(args, 'route', '--route'),
        ...enumOption(args, 'access', '--access', ACCESS_VALUES),
        ...booleanOption(args, 'softDelete', '--soft-delete'),
        ...booleanOption(args, 'verify', '--verify'),
        ...enumOption(args, 'testMode', '--test-mode', TEST_MODE_VALUES),
        ...booleanOption(args, 'dryRun', '--dry-run'),
        ...booleanOption(args, 'force', '--force'),
      ]),
  },
  {
    name: 'auth_install',
    description:
      'Install session + personal API token authentication: the auth module, users/sessions/api_tokens tables, ' +
      'config section, kernel guard and /api/v1/auth mount. Run db_migrate afterwards.',
    inputSchema: objectSchema({
      guards: stringProperty("Comma-separated guards: 'session', 'api-token' (default: both)"),
      dryRun: { type: 'boolean', description: 'Preview file changes, install and migration plan; write nothing' },
      force: { type: 'boolean', description: 'Overwrite generator-owned files of the auth module only' },
    }),
    handler: (args) =>
      cli('make:auth', () => [
        ...option(args, 'guards', '--guards'),
        ...booleanOption(args, 'dryRun', '--dry-run'),
        ...booleanOption(args, 'force', '--force'),
      ]),
  },
  {
    name: 'queue_status',
    description: 'Job counts per state (waiting/active/completed/failed/delayed). Requires reachable Redis.',
    inputSchema: objectSchema({ queue: stringProperty('Queue name filter') }),
    handler: (args) => cli('queue:status', () => option(args, 'queue', '--queue')),
  },
  {
    name: 'workflow_list',
    description: 'Paginated durable workflow runs with status, correlation and start time. Requires PostgreSQL.',
    inputSchema: objectSchema({
      workflow: stringProperty('Workflow name filter'),
      status: stringProperty('Run status filter'),
      limit: { type: 'number', description: 'Maximum runs to return' },
    }),
    handler: (args) =>
      cli('workflow:list', () => [
        ...option(args, 'workflow', '--workflow'),
        ...option(args, 'status', '--status'),
        ...numberOption(args, 'limit', '--limit'),
      ]),
  },
  {
    name: 'workflow_status',
    description: 'One workflow run with its full node tree (pipeline/stage/action paths, attempts, errors).',
    inputSchema: objectSchema({ id: stringProperty('Run id or id prefix') }, ['id']),
    handler: (args) => cli('workflow:status', () => positional(args, 'id')),
  },
  {
    name: 'workflow_retry',
    description:
      'Re-run a failed/compensated workflow from its failure point (optionally from a node path). Needs Redis.',
    inputSchema: objectSchema({
      id: stringProperty('Run id or id prefix'),
      from: stringProperty('Node path to retry from'),
    }),
    handler: (args) => cli('workflow:retry', () => [...positional(args, 'id'), ...option(args, 'from', '--from')]),
  },
  {
    name: 'workflow_cancel',
    description: 'Cancel a pending, running or waiting workflow run.',
    inputSchema: objectSchema({ id: stringProperty('Run id or id prefix') }, ['id']),
    handler: (args) => cli('workflow:cancel', () => positional(args, 'id')),
  },
  {
    name: 'schedule_list',
    description: 'Registered BullMQ timetables with their next due run. Requires reachable Redis.',
    inputSchema: objectSchema({}),
    handler: () => cli('schedule:list', () => []),
  },
  {
    name: 'openapi_generate',
    description: 'Emit the OpenAPI 3.1 document for documented operations.',
    inputSchema: objectSchema(
      {
        output: stringProperty('Output file path'),
        apiVersion: stringProperty('API version metadata'),
      },
      ['output'],
    ),
    handler: (args) =>
      cli('openapi:generate', () => [
        ...option(args, 'output', '--output'),
        ...option(args, 'apiVersion', '--api-version'),
      ]),
  },
  {
    name: 'openapi_check',
    description: 'Validate the OpenAPI document against the live route table (drift check).',
    inputSchema: objectSchema({}),
    handler: () => cli('openapi:check', () => []),
  },
  {
    name: 'checks',
    description:
      'Run project tooling through the CLI (which delegates to the configured executables): typecheck, lint, ' +
      'test (endpoint suites use an isolated database) or format.',
    inputSchema: objectSchema(
      {
        kind: { type: 'string', enum: [...CHECK_KINDS], description: 'Which check to run' },
        filter: stringProperty('test: filter tests by name'),
        fix: { type: 'boolean', description: 'lint: apply safe fixes' },
        check: { type: 'boolean', description: 'format: verify without writing' },
      },
      ['kind'],
    ),
    handler: (args) => {
      const kind = enumOption(args, 'kind', '', CHECK_KINDS).join('');
      const build = (): string[] => {
        if (kind === 'test') return [...option(args, 'filter', '--filter')];
        if (kind === 'lint') return [...booleanOption(args, 'fix', '--fix')];
        if (kind === 'format') return [...booleanOption(args, 'check', '--check')];
        return [];
      };
      return cli(kind, build);
    },
  },
  {
    name: 'docs_list',
    description: 'Readable framework documentation files (repo guides and specifications).',
    inputSchema: objectSchema({}),
    handler: async () => ({ documents: listDocs() }),
  },
  {
    name: 'docs_read',
    description: 'Read one documentation file (use docs_list for valid paths, e.g. "docs/cli-reference.md").',
    inputSchema: objectSchema({ path: stringProperty('Workspace-relative document path') }, ['path']),
    handler: async (args) => ({ path: args.path, content: readDoc(String(args.path ?? '')) }),
  },
  {
    name: 'docs_search',
    description: 'Case-insensitive search across all framework documentation. Returns matching lines with locations.',
    inputSchema: objectSchema({
      query: stringProperty('Text to search for'),
      limit: { type: 'number', description: 'Maximum matches (default 20)' },
    }),
    handler: async (args) => {
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 20;
      return { query: args.query, matches: searchDocs(String(args.query ?? ''), limit) };
    },
  },
];

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const spec = toolSpecs.find((tool) => tool.name === name);
  if (!spec) {
    return {
      text: `Unknown tool "${name}". Available: ${toolSpecs.map((tool) => tool.name).join(', ')}`,
      isError: true,
    };
  }
  try {
    const result = await spec.handler(args ?? {});
    if (typeof result === 'string') {
      // CLI results encode failure in the exit code parsed out of the rendered JSON.
      const parsed = JSON.parse(result) as { exitCode?: number };
      return { text: result, isError: (parsed.exitCode ?? 0) !== 0 };
    }
    return { text: JSON.stringify(result, null, 2), isError: false };
  } catch (error) {
    return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
