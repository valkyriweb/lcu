// A stand-in original CUA server for the app-update restart tests: each process logs its start and calls, and
// `js` codes reproduce the original Sky client's native pipe startup failure.
import { appendFileSync, existsSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const FAILURE = 'Sky Computer Use native pipe startup failed';
const log = value => appendFileSync(process.env.LCU_FIXTURE_LOG, `${JSON.stringify({ pid: process.pid, ...value })}\n`);

// A start that must fail (the restart failure test) exits before it answers initialize.
if (process.env.LCU_FIXTURE_FAIL_START && existsSync(process.env.LCU_FIXTURE_FAIL_START)) {
  log({ type: 'start-refused' });
  process.exit(3);
}

const server = new Server({ name: 'original-cua-app-update-fixture', version: '1' }, {
  capabilities: { tools: {} }, instructions: 'Original app-update fixture instructions.',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'js', description: 'Original JS.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
  } },
  { name: 'js_reset', description: 'Original reset.', inputSchema: { type: 'object', properties: {} } },
  { name: 'js_add_node_module_dir', description: 'Internal.', inputSchema: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  } },
  { name: 'turn_ended', description: 'Internal.', inputSchema: { type: 'object' } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {}, _meta } = request.params;
  log({ type: 'call', name, args, turn: _meta?.['x-codex-turn-metadata']?.turn_id });
  // Still running when a restart closes this server.
  if (name === 'js' && args.code === 'hold') await new Promise(resolve => setTimeout(resolve, 10_000));
  if (name === 'js' && args.code === 'slow-pipe-failure') await new Promise(resolve => setTimeout(resolve, 300));
  if (name === 'js' && (args.code === 'pipe-failure' || args.code === 'slow-pipe-failure')) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${FAILURE}` }] };
  }
  if (name === 'js' && args.code === 'pipe-throw') throw new Error(FAILURE);
  return { content: [{ type: 'text', text: name === 'js' ? `${process.pid}:${args.code}` : name }] };
});

log({ type: 'start' });
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
