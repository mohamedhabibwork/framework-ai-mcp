import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { frameworkPaths } from './cli';
import { listDocs, readDoc } from './docs';
import { callTool, toolSpecs } from './tools';

export const SERVER_NAME = 'hono-framework';

/** Builds the MCP server: framework CLI tools plus documentation resources. */
export function createFrameworkServer(version: string): Server {
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { text, isError } = await callTool(name, args);
    return { content: [{ type: 'text', text }], isError };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listDocs().map((doc) => ({
      uri: `fwdocs://${doc.path}`,
      name: doc.title,
      mimeType: 'text/markdown',
      description: `Framework documentation: ${doc.path}`,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = String(request.params.uri ?? '');
    const prefix = 'fwdocs://';
    if (!uri.startsWith(prefix)) {
      throw new Error(`Unsupported resource scheme: ${uri}`);
    }
    const path = uri.slice(prefix.length);
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: readDoc(path) }],
    };
  });

  return server;
}

export { frameworkPaths };
