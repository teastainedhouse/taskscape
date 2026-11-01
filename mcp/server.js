#!/usr/bin/env node
// Taskscape MCP server over stdio.
//
//   TASKSCAPE_URL=http://localhost:3000 TASKSCAPE_TOKEN=tsk_... node mcp/server.js
//
// One process = one session: a fresh session id is generated at startup and
// sent as X-Taskscape-Session on every request, so the activity log can tell
// Claude sessions apart. stdout is the MCP transport; diagnostics go to stderr.

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from './client.js';
import { DATA_NOTICE, TOOLS, callTool } from './tools.js';

const NAME = 'taskscape';
const VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Taskscape is a small work tracker: projects contain tasks; both can carry tags and guestbook comments, and be marked private.',
  'You act as the person who owns the token, and you only see what they can see.',
  'Read with list_projects, list_tasks and get. Every write (update, delete, restore, tag) needs the record\'s current "version" from the latest get or list; a conflict returns the current record so you can retry with its version.',
  'delete moves ONE item to the trash (restore undoes it), including a guestbook comment the user wrote; never trash several items without the user confirming each one.',
  DATA_NOTICE,
].join(' ');

/** @param {string} line */
function die(line) {
  process.stderr.write(line + '\n');
  process.exit(1);
}

const baseUrl = (process.env.TASKSCAPE_URL ?? '').trim().replace(/\/+$/, '');
const token = (process.env.TASKSCAPE_TOKEN ?? '').trim();
if (!baseUrl) die('taskscape-mcp: TASKSCAPE_URL is not set (the API origin, e.g. http://localhost:3000).');
if (!token) die('taskscape-mcp: TASKSCAPE_TOKEN is not set (a personal token from the "My MCP tokens" page).');
if (!/^https?:\/\//i.test(baseUrl)) die('taskscape-mcp: TASKSCAPE_URL must start with http:// or https://.');

const sessionId = randomUUID();
const client = createClient({ baseUrl, token, sessionId });

const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return callTool(name, args ?? {}, client);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`taskscape-mcp: connected to ${baseUrl} (session ${sessionId})\n`);
