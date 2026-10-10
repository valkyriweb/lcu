// Run only from desktop.sh in the disposable Linux desktop/account, never on a personal desktop.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'linux');
assert.ok(process.env.LCU_TEST_OUTPUT, 'Requires the disposable desktop.sh fixture');
const root = process.env.LCU_ADAPTER_ROOT ?? '/opt/lcu/current';
const adapters = join(root, 'adapters');
const command = process.argv.slice(2);
if (!command.length) command.push(join(root, 'bin/lcu'));
const node = readFileSync(join(root, 'node-path'), 'utf8').trim();
const load = path => import(pathToFileURL(path).href);
const { captureMetadata } = await load(join(adapters, 'metadata.mjs'));
const { default: piExtension } = await load(join(adapters, 'pi/index.ts'));
const { Client } = await load(join(adapters, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const { StdioClientTransport } = await load(join(adapters, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));
process.env.LCU_IDLE_TIMEOUT_MS = '1000';

function helpers() {
  const found = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (/(cua-repl\.mjs|node_repl|\/kernel\.js|\/trusted-worker\.js|\/sky_linux(?:_[a-z0-9]+)?)(?: |$)/.test(argv)) {
        found.set(Number(entry), argv);
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return found;
}
const preexisting = helpers();
const owned = () => [...helpers()].filter(([pid]) => !preexisting.has(pid));
async function gone() {
  const deadline = Date.now() + 15000;
  while (owned().length) {
    assert.ok(Date.now() < deadline, `Original helpers survived: ${JSON.stringify(owned())}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

await captureMetadata(command);
await gone();

async function pi() {
  const handlers = new Map();
  const tools = new Map();
  const warnings = [];
  const ctx = { sessionManager: { getSessionId: () => 'lcu-disposable-lifetime' }, hasUI: false,
    ui: { notify: message => warnings.push(message) } };
  piExtension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand() {} }, { command });
  await handlers.get('before_agent_start')({ systemPrompt: 'test', systemPromptOptions: {} }, ctx);
  await handlers.get('agent_start')({}, ctx);
  assert.deepEqual(warnings, [], 'Real setup metadata should avoid eager fallback');
  return { call: () => tools.get('js').execute('state', { code: 'await cua.getState()' }, undefined, undefined, ctx),
    close: () => handlers.get('session_shutdown')() };
}
async function codex() {
  const client = new Client({ name: 'lcu-disposable-lifetime', version: '1' });
  const transport = new StdioClientTransport({ command: node, args: [join(adapters, 'codex.mjs'), ...command],
    env: { ...process.env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  await client.listTools();
  assert.doesNotMatch(stderr, /eager startup/);
  return { call: async () => {
    const result = await client.callTool({ name: 'js', arguments: { code: 'await cua.getState()' },
      _meta: { 'x-codex-turn-metadata': { session_id: 'lcu-disposable-lifetime', turn_id: 'test' } } });
    if (result.isError) throw new Error(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
    return result;
  }, close: () => client.close() };
}

for (const [name, create] of [['Pi', pi], ['Codex', codex]]) {
  const unused = await create();
  assert.deepEqual(owned(), [], `${name} initialized a helper despite valid metadata`);
  await unused.close();
  assert.deepEqual(owned(), [], `${name} shutdown started a helper for an unused session`);
  const host = await create();
  try {
    const result = await host.call();
    assert.ok(result.content.length);
    const running = owned();
    assert.ok(running.some(([, argv]) => /node_repl/.test(argv)), `${name} did not start the original runtime`);
    assert.ok(running.some(([, argv]) => /\/sky_linux(?:_[a-z0-9]+)?(?: |$)/.test(argv)), `${name} did not start the original Sky engine`);
    await gone();
    await assert.rejects(host.call(), /idle.*runtime/s);
    assert.ok((await host.call()).content.length);
    assert.ok(owned().length, `${name} did not restart`);
    await host.close();
    await gone();
    console.log(`PASS: ${name} original runtime: cached unused session has no helpers; getState, idle teardown, restart and shutdown (${running.length} runtime/helper processes observed)`);
  } finally { await host.close(); }
}
