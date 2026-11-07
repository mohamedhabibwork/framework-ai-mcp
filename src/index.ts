#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { frameworkPaths, frameworkVersion } from './cli';
import { createFrameworkServer, SERVER_NAME } from './server';

/**
 * MCP server for the hono-framework workspace. Exposes the application CLI
 * (in-process, machine-readable `--json` envelope) as tools and the repository
 * documentation as resources.
 *
 * Configuration:
 *   FRAMEWORK_APP_DIR        app directory (workspace-relative), default apps/playground
 *   FRAMEWORK_ROOT           workspace root override
 *   FRAMEWORK_MCP_TIMEOUT_MS per-invocation timeout, default 120000
 */
async function main(): Promise<void> {
  const paths = frameworkPaths();
  const server = createFrameworkServer(await frameworkVersion());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ready (app: ${paths.appDir})`);
}

main().catch((error: unknown) => {
  console.error(`${SERVER_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
