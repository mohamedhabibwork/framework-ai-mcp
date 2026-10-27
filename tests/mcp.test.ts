import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertRunnableCommand, frameworkPaths, frameworkVersion, runCliCommand, timeoutMs } from '../src/cli';
import { listDocs, readDoc, searchDocs } from '../src/docs';
import { createFrameworkServer } from '../src/server';
import { callTool, toolSpecs } from '../src/tools';

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = createFrameworkServer('test');
  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('framework paths', () => {
  test('locates the workspace and the app CLI entry', () => {
    const paths = frameworkPaths();
    expect(paths.cliEntry.endsWith('bin/cli.ts')).toBe(true);
  });
});

describe('command admission', () => {
  test('rejects long-running commands', () => {
    for (const command of ['serve', 'dev', 'queue:work', 'schedule:work']) {
      expect(() => assertRunnableCommand(command)).toThrow(/long-running/);
    }
  });

  test('rejects names outside the command grammar', () => {
    for (const command of ['DB:STATUS', '1list', 'a b', 'list;rm', '']) {
      expect(() => assertRunnableCommand(command)).toThrow(/Invalid command name/);
    }
  });

  test('accepts ordinary command names', () => {
    expect(() => assertRunnableCommand('db:status')).not.toThrow();
    expect(() => assertRunnableCommand('make:crud')).not.toThrow();
  });

  test('argument values must be plain strings within the size bound', async () => {
    expect(runCliCommand('list', [42 as unknown as string])).rejects.toThrow(/plain strings/);
    expect(runCliCommand('list', ['x'.repeat(4097)])).rejects.toThrow(/plain strings/);
  });

  test('timeout parsing falls back to the 120s default on bad values', () => {
    const original = process.env.FRAMEWORK_MCP_TIMEOUT_MS;
    try {
      delete process.env.FRAMEWORK_MCP_TIMEOUT_MS;
      expect(timeoutMs()).toBe(120_000);
      for (const raw of ['5', '500', '3600000']) {
        process.env.FRAMEWORK_MCP_TIMEOUT_MS = raw;
        expect(timeoutMs()).toBe(Number(raw));
      }
      for (const raw of ['0', '-3', 'abc']) {
        process.env.FRAMEWORK_MCP_TIMEOUT_MS = raw;
        expect(timeoutMs()).toBe(120_000);
      }
    } finally {
      if (original === undefined) delete process.env.FRAMEWORK_MCP_TIMEOUT_MS;
      else process.env.FRAMEWORK_MCP_TIMEOUT_MS = original;
    }
  });
});

describe('documentation helpers', () => {
  test('lists and reads whitelisted docs, rejects traversal', () => {
    const docs = listDocs();
    expect(docs.some((doc) => doc.path === 'docs/cli-reference.md')).toBe(true);
    expect(readDoc('docs/cli-reference.md')).toContain('CLI reference');
    expect(() => readDoc('../../etc/passwd')).toThrow();
    expect(() => readDoc('package.json')).toThrow(/Unknown document/);
  });

  test('searches across docs', () => {
    const matches = searchDocs('make:crud');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.path).toContain('.md');
  });

  test('clamps limits and ignores blank queries', () => {
    expect(searchDocs('make:crud', 1)).toHaveLength(1);
    expect(searchDocs('make:crud', 0)).toEqual([]);
    expect(searchDocs('   ', 20)).toEqual([]);
  });
});

describe('in-process CLI bridge', () => {
  test('runs a read-only command and parses the envelope', async () => {
    const result = await runCliCommand('list');
    expect(result.exitCode).toBe(0);
    expect(result.envelope?.status).toBe('ok');
    expect(Array.isArray((result.envelope?.data as { commands?: unknown[] })?.commands)).toBe(true);
  });

  test('banned global flags are stripped before the CLI sees them', async () => {
    const result = await callTool('run_command', { command: 'list', args: ['--help', '--json'] });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text) as { exitCode: number; envelope: { status: string } };
    expect(payload.exitCode).toBe(0);
    expect(payload.envelope.status).toBe('ok');
  });

  test('unknown commands surface the usage envelope', async () => {
    const result = await runCliCommand('mcp:no-such-command');
    expect(result.exitCode).toBe(2);
    expect(result.envelope?.status).toBe('error');
  });

  test('reports the application framework version, not a literal', async () => {
    expect(await frameworkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('tool calls', () => {
  test('unknown tool names fail with the available set', async () => {
    const result = await callTool('not_a_tool', {});
    expect(result.isError).toBe(true);
    expect(result.text.startsWith('Unknown tool "not_a_tool"')).toBe(true);
    expect(result.text).toContain('crud_scaffold');
  });

  test('the checks tool requires kind in its published schema', () => {
    const checks = toolSpecs.find((tool) => tool.name === 'checks');
    expect(checks).toBeDefined();
    if (!checks) return;
    const schema = checks.inputSchema as {
      required?: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toContain('kind');
    expect(schema.properties.kind?.enum).toEqual(['typecheck', 'lint', 'test', 'format']);
  });
});

describe('mcp server', () => {
  test('exposes the structured tool catalog', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('crud_scaffold');
      expect(names).toContain('db_migrate');
      expect(names).toContain('docs_read');
      expect(names.length).toBe(toolSpecs.length);
    });
  });

  test('runs the catalog tool and reports success', async () => {
    await withClient(async (client) => {
      const result = (await client.callTool({ name: 'catalog', arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}') as {
        exitCode: number;
        envelope: { status: string };
      };
      expect(payload.exitCode).toBe(0);
      expect(payload.envelope.status).toBe('ok');
    });
  });

  test('rejects long-running commands with an error result', async () => {
    await withClient(async (client) => {
      const result = (await client.callTool({
        name: 'run_command',
        arguments: { command: 'queue:work' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    });
  });

  test('reads documentation through resources and the docs_read tool', async () => {
    await withClient(async (client) => {
      const { resources } = await client.listResources();
      expect(resources.some((resource) => resource.uri === 'fwdocs://docs/testing.md')).toBe(true);

      const reading = await client.readResource({ uri: 'fwdocs://docs/testing.md' });
      const firstContent = reading.contents[0];
      expect(firstContent && 'text' in firstContent ? firstContent.text : '').toContain('Test');

      const tool = (await client.callTool({
        name: 'docs_read',
        arguments: { path: 'docs/testing.md' },
      })) as CallToolResult;
      expect(tool.isError).toBe(false);
    });
  });
});
