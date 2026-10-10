import { appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const record = value => appendFileSync(process.env.LCU_LIFETIME_LOG, `${JSON.stringify(value)}\n`);
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
record({ event: 'start', pid: process.pid, helper: helper.pid });
const server = new Server({ name: 'lifetime-fixture', version: '1' }, {
  capabilities: { tools: {} }, instructions: 'Synthetic lifetime instructions; preserve these bytes.\n',
});
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
  { name: 'js', description: 'Synthetic JS.', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'js_reset', description: 'Synthetic reset.', inputSchema: { type: 'object', properties: {} } },
  { name: 'turn_ended', inputSchema: { type: 'object' } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  record({ event: 'call', name: request.params.name, code: request.params.arguments?.code, pid: process.pid });
  if (request.params.arguments?.code === 'hold') {
    while (!existsSync(process.env.LCU_LIFETIME_RELEASE)) await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { content: [{ type: 'text', text: request.params.arguments?.code ?? 'ok' }] };
});
let shuttingDown;
function close() {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    const exit = once(helper, 'exit');
    helper.kill('SIGTERM');
    await exit;
    record({ event: 'exit', pid: process.pid, helper: helper.pid });
    await server.close();
    process.exit(0);
  })();
  return shuttingDown;
}
process.once('SIGTERM', close);
process.stdin.once('end', close);
await server.connect(new StdioServerTransport());
