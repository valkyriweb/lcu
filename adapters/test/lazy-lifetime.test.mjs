import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureMetadata, readMetadata } from '../metadata.mjs';
import { DEFAULT_IDLE_TIMEOUT_MS, createRuntimeLifetime, idleTimeout } from '../runtime-lifetime.mjs';
import piExtension from '../pi/index.ts';

const fixture = fileURLToPath(new URL('./lifetime-fixture.mjs', import.meta.url));
const command = [process.execPath, fixture];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for owned fixture process state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'lcu-lazy-'));
  const env = { PATH: process.env.PATH, HOME: home, LCU_LIFETIME_LOG: join(home, 'events'),
    LCU_LIFETIME_RELEASE: join(home, 'release'), LCU_IDLE_TIMEOUT_MS: '40', LCU_LOG: 'off' };
  const events = () => existsSync(env.LCU_LIFETIME_LOG)
    ? readFileSync(env.LCU_LIFETIME_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const starts = () => events().filter(event => event.event === 'start');
  const empty = () => starts().every(({ pid, helper }) => !alive(pid) && !alive(helper));
  t.after(() => { if (existsSync(home)) writeFileSync(env.LCU_LIFETIME_RELEASE, 'release'); });
  return { home, env, events, starts, empty };
}

for (const adapter of ['pi', 'codex']) {
  async function harness(t, fixtureState) {
    const { env } = fixtureState;
    const warnings = [];
    if (adapter === 'codex') {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../codex.mjs', import.meta.url)), ...command], env, stderr: 'pipe' });
      transport.stderr.on('data', chunk => warnings.push(chunk.toString()));
      const client = new Client({ name: 'lazy-test', version: '1' });
      await client.connect(transport);
      t.after(async () => { await client.close(); await waitFor(fixtureState.empty); rmSync(fixtureState.home, { recursive: true, force: true }); });
      return { warnings, begin: async () => {}, end: async () => {
        await client.callTool({ name: 'turn_ended', arguments: { session_id: 'test', turn_id: 'turn', hook_event_name: 'Stop' } });
      }, list: () => client.listTools(), instructions: () => client.getInstructions(),
      call: async code => {
        const result = await client.callTool({ name: 'js', arguments: { code } });
        if (result.isError) throw new Error(result.content[0].text);
        return result;
      }, close: () => client.close() };
    }
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env, { LCU_MCP_COMMAND: JSON.stringify(command) });
    t.after(() => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    });
    const handlers = new Map();
    const tools = new Map();
    const ctx = { sessionManager: { getSessionId: () => 'test' }, hasUI: false,
      ui: { notify: message => warnings.push(message) } };
    piExtension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand() {} });
    const options = { appendSystemPrompt: '' };
    const prepare = () => handlers.get('before_agent_start')({ systemPrompt: 'base', systemPromptOptions: options }, ctx);
    await prepare();
    const close = () => handlers.get('session_shutdown')();
    t.after(async () => { await close(); await waitFor(fixtureState.empty); rmSync(fixtureState.home, { recursive: true, force: true }); });
    return { warnings, begin: async () => { await prepare(); await handlers.get('agent_start')({}, ctx); },
      end: () => handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx),
      list: async () => ({ tools: [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }),
      instructions: () => options.appendSystemPrompt,
      call: code => tools.get('js').execute('call', { code }, undefined, undefined, ctx), close };
  }

  test(`${adapter}: cached discovery/unused turns spawn nothing; idle releases both owned processes and allows restart`, async t => {
    const state = sandbox(t);
    const metadata = await captureMetadata(command, { env: state.env });
    await waitFor(state.empty);
    rmSync(state.env.LCU_LIFETIME_LOG);
    const host = await harness(t, state);
    await host.begin();
    assert.equal(host.instructions(), metadata.instructions);
    const listed = await host.list();
    assert.deepEqual(listed.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      metadata.tools.filter(tool => ['js', 'js_reset'].includes(tool.name)));
    await host.end();
    assert.deepEqual(state.starts(), []);
    await host.begin();
    assert.equal((await host.call('first')).content[0].text, 'first');
    assert.equal(state.starts().length, 1);
    await host.end();
    await waitFor(state.empty);
    await host.begin();
    await assert.rejects(host.call('stale binding'), /idle.*runtime/s);
    assert.equal((await host.call('restart')).content[0].text, 'restart');
    assert.equal(state.starts().length, 2);
    await host.close();
    await waitFor(state.empty);
    assert.equal(host.warnings.length, 0);
  });

  test(`${adapter}: missing and stale cache fall back eagerly with one refresh warning`, async t => {
    for (const stale of [false, true]) {
      await t.test(stale ? 'stale configuration' : 'missing cache', async t => {
        const state = sandbox(t);
        if (stale) {
          await captureMetadata(command, { env: state.env });
          await waitFor(state.empty);
          rmSync(state.env.LCU_LIFETIME_LOG);
          state.env.CUA_REPL_ENABLED_SURFACES = 'computer';
        }
        const host = await harness(t, state);
        assert.equal(state.starts().length, 1);
        await host.begin();
        await host.list();
        assert.equal((await host.call('fallback')).content[0].text, 'fallback');
        assert.equal(host.warnings.join('').match(/LCU is using eager startup/g)?.length, 1);
        assert.match(host.warnings.join(''), /setup again/);
        await host.close();
        await waitFor(state.empty);
      });
    }
  });

  test(`${adapter}: idle cannot terminate an in-flight call; shutdown waits and removes its helper`, async t => {
    const state = sandbox(t);
    await captureMetadata(command, { env: state.env });
    await waitFor(state.empty);
    rmSync(state.env.LCU_LIFETIME_LOG);
    const host = await harness(t, state);
    await host.begin();
    const held = host.call('hold');
    await waitFor(() => state.events().some(event => event.code === 'hold'));
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(state.empty(), false);
    assert.equal(state.events().some(event => event.event === 'exit'), false);
    // MCP transport shutdown cancels downstream requests in Codex; Pi owns and drains its direct call.
    if (adapter === 'pi') {
      const closing = host.close();
      writeFileSync(state.env.LCU_LIFETIME_RELEASE, 'release');
      assert.equal((await held).content[0].text, 'hold');
      await closing;
    } else {
      writeFileSync(state.env.LCU_LIFETIME_RELEASE, 'release');
      assert.equal((await held).content[0].text, 'hold');
      await host.close();
    }
    await waitFor(state.empty);
  });
}

test('metadata cache is private and configuration-bound; setup captures original descriptors', async t => {
  const state = sandbox(t);
  const original = await captureMetadata(command, { env: state.env });
  await waitFor(state.empty);
  assert.deepEqual(await readMetadata(command, { env: state.env }), original);
  const directory = join(state.home, '.cache/lcu/mcp-metadata');
  const file = join(directory, readdirSync(directory)[0]);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  await assert.rejects(readMetadata(command, { env: { ...state.env, NODE_REPL_TOOL_OVERRIDES: '{}' } }), /setup again/);
  // Idle timeout is not part of the instruction configuration.
  assert.deepEqual(await readMetadata(command, { env: { ...state.env, LCU_IDLE_TIMEOUT_MS: '200' } }), original);
  rmSync(state.home, { recursive: true, force: true });
});

test('idle timeout defaults to ten minutes and rejects timer overflow/invalid values', () => {
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 600000);
  assert.equal(idleTimeout({}), 600000);
  for (const value of ['', '0', '-1', '1.5', '2147483648', 'NaN']) assert.throws(() => idleTimeout({ LCU_IDLE_TIMEOUT_MS: value }));
  assert.equal(idleTimeout({ LCU_IDLE_TIMEOUT_MS: '123' }), 123);
});

test('concurrent startup and idle-close requests share one generation; shutdown rejects later calls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveStart;
  let resolveClose;
  let starts = 0;
  let closes = 0;
  const lifetime = createRuntimeLifetime(async () => {
    starts++;
    if (starts === 1) await new Promise(resolve => { resolveStart = resolve; });
    return { close: async () => { closes++; await new Promise(resolve => { resolveClose = resolve; }); } };
  }, { timeout: 10 });
  const first = lifetime.run(() => 'first');
  await Promise.resolve(); await Promise.resolve();
  const concurrent = lifetime.run(() => 'concurrent');
  resolveStart();
  assert.equal(await first, 'first');
  assert.equal(await concurrent, 'concurrent');
  assert.equal(starts, 1);
  t.mock.timers.tick(10);
  const second = lifetime.run(() => 'second');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(starts, 1);
  resolveClose();
  assert.equal(await second, 'second');
  assert.equal(starts, 2);
  const shutdown = lifetime.close();
  await Promise.resolve(); await Promise.resolve();
  resolveClose();
  await shutdown;
  assert.equal(closes, 2);
  await assert.rejects(lifetime.run(() => {}), /shutting down/);
});
