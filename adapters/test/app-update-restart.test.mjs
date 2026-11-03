import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  APP_UPDATED_RESTART_TEXT, createAppUpdateRestart, createCuaClient, NATIVE_PIPE_FAILURE, nativePipeFailed,
  selectedAppBuild,
} from '../client.mjs';

const fixture = fileURLToPath(new URL('./app-update-fixture.mjs', import.meta.url));
const claudeRelay = fileURLToPath(new URL('../claude.mjs', import.meta.url));
const codexRelay = fileURLToPath(new URL('../codex.mjs', import.meta.url));

const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

function readRecords(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** A temporary directory with the fixture log and a file holding the app build the tests change. */
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-app-update-'));
  const build = join(directory, 'build');
  const logPath = join(directory, 'fixture.jsonl');
  writeFileSync(build, 'build-1');
  return {
    directory,
    logPath,
    build,
    setBuild(value) { writeFileSync(build, value); },
    starts: () => readRecords(logPath).filter(entry => entry.type === 'start').map(entry => entry.pid),
    calls: code => readRecords(logPath).filter(entry => entry.type === 'call' && entry.args?.code === code),
    records: () => readRecords(logPath),
    remove() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function captureLog() {
  const events = [];
  return { events, path: undefined, event(type, fields) { events.push({ event: type, ...fields }); } };
}

function sharedClient(space, log = captureLog()) {
  return createCuaClient({
    command: [process.execPath, fixture],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: space.directory, LCU_FIXTURE_LOG: space.logPath,
      LCU_FIXTURE_FAIL_START: join(space.directory, 'fail-start') },
    appBuild: () => readFileSync(space.build, 'utf8'),
    log,
  });
}

const turn = { sessionId: 'session-update', turnId: 'turn-update' };

test('nativePipeFailed matches the exact original text in tool errors and thrown errors only', () => {
  assert.equal(nativePipeFailed({ result: { isError: true, content: [{ type: 'text', text: `x ${NATIVE_PIPE_FAILURE} y` }] } }), true);
  assert.equal(nativePipeFailed({ result: { content: [{ type: 'text', text: NATIVE_PIPE_FAILURE }] } }), false);
  assert.equal(nativePipeFailed({ result: { isError: true, content: [{ type: 'text', text: 'native pipe failed' }] } }), false);
  assert.equal(nativePipeFailed({ error: new Error(`MCP error -32603: ${NATIVE_PIPE_FAILURE}`) }), true);
  assert.equal(nativePipeFailed({ error: new Error('Connection closed') }), false);
});

test('createAppUpdateRestart restarts only for a readable, changed build of the current generation', async () => {
  let build = 'a';
  const restarts = createAppUpdateRestart({ build: () => build, log: captureLog() });
  const failure = { result: { isError: true, content: [{ type: 'text', text: NATIVE_PIPE_FAILURE }] } };
  let restarted = 0;
  const restart = async () => { restarted += 1; restarts.begin(); };
  const first = restarts.begin();
  assert.equal(await restarts.afterJs(first, failure, restart), undefined, 'unchanged build');
  build = undefined;
  assert.equal(await restarts.afterJs(first, failure, restart), undefined, 'unreadable build (update in progress)');
  build = 'b';
  assert.equal(await restarts.afterJs(first, { result: { content: [] } }, restart), undefined, 'not a failure');
  const replaced = await restarts.afterJs(first, failure, restart);
  assert.equal(text(replaced), APP_UPDATED_RESTART_TEXT);
  assert.equal(replaced.isError, true);
  // A late failure of the replaced generation shares that restart.
  assert.equal(text(await restarts.afterJs(first, failure, restart)), APP_UPDATED_RESTART_TEXT);
  assert.equal(restarted, 1);
  // A call the restart's close failed shares that restart; a fresh generation's transport error passes through.
  const closed = { error: new Error('MCP error -32000: Connection closed') };
  assert.equal(text(await restarts.afterJs(first, closed, restart)), APP_UPDATED_RESTART_TEXT);
  assert.equal(await restarts.afterJs(restarts.current, closed, restart), undefined, 'no restart under way');
  assert.equal(await restarts.afterJs(restarts.current, failure, restart), undefined, 'fresh generation, same build');
  // A generation started without a readable build never restarts.
  build = undefined;
  const unknown = restarts.begin();
  build = 'c';
  assert.equal(await restarts.afterJs(unknown, failure, restart), undefined);
  assert.equal(restarted, 1);
});

/** A minimal LCU release tree selecting a fake macOS app, as `lcu setup` installs it. */
function fakeRelease(directory) {
  const app = join(directory, 'Applications', 'ChatGPT.app');
  const root = join(directory, 'releases', '0.0.0-test');
  mkdirSync(join(app, 'Contents', 'Resources', 'cua_node', 'bin'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist>1</plist>');
  writeFileSync(join(app, 'Contents', 'Resources', 'cua_node', 'bin', 'node_repl'), 'old');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lcu'), { recursive: true });
  for (const name of ['lcu', 'lcu-session']) {
    writeFileSync(join(root, 'bin', name), '#!/bin/sh\n');
    chmodSync(join(root, 'bin', name), 0o755);
  }
  writeFileSync(join(root, 'lcu', 'runtime.mjs'), '');
  writeFileSync(join(root, 'lcu', 'session.mjs'), '');
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform: 'darwin', app, architecture: 'arm64' }));
  symlinkSync(app, join(root, 'app'), 'dir');
  symlinkSync(root, join(directory, 'current'), 'dir');
  return { app, root, launcher: join(directory, 'current', 'bin', 'lcu') };
}

// Symbolic links and execute bits as the macOS release tree has them; the function reads only the file system.
test('selectedAppBuild identifies the selected macOS app build on disk from the upstream command',
  { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-app-build-'));
  try {
    const { app, root, launcher } = fakeRelease(directory);
    const darwin = { platform: 'darwin', env: { PATH: join(root, 'bin') } };
    const first = selectedAppBuild([launcher, '--chrome'], darwin);
    assert.equal(typeof first, 'string');
    assert.equal(JSON.parse(first).app.endsWith(join('Applications', 'ChatGPT.app')), true);
    assert.equal(selectedAppBuild([launcher], darwin), first, 'stable while the app is unchanged');
    // The PATH form and the lcu-session form select the same release.
    assert.equal(selectedAppBuild(['lcu'], darwin), first);
    assert.equal(selectedAppBuild([join(root, 'bin', 'lcu-session'), '--user', 'me', '--', launcher], darwin), first);
    assert.equal(selectedAppBuild([join(root, 'bin', 'lcu-session'), '--user=me', '--', 'lcu'], darwin), first);
    // Other platforms and commands that are not an LCU launcher have no build.
    assert.equal(selectedAppBuild([launcher], { ...darwin, platform: 'linux' }), undefined);
    assert.equal(selectedAppBuild([process.execPath, fixture], darwin), undefined);
    // An update replaces the files in place: a new inode and change time.
    const plist = join(app, 'Contents', 'Info.plist');
    writeFileSync(`${plist}.new`, '<plist>2</plist>');
    renameSync(`${plist}.new`, plist);
    const second = selectedAppBuild([launcher], darwin);
    assert.equal(typeof second, 'string');
    assert.notEqual(second, first);
    // A missing file (an update in progress) has no build.
    const repl = join(app, 'Contents', 'Resources', 'cua_node', 'bin', 'node_repl');
    rmSync(repl);
    assert.equal(selectedAppBuild([launcher], darwin), undefined);
    writeFileSync(repl, 'new');
    assert.equal(typeof selectedAppBuild([launcher], darwin), 'string');
    // A descriptor that does not select the release's app link is refused, as lcu/runtime.mjs refuses it.
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform: 'darwin', app: directory }));
    assert.equal(selectedAppBuild([launcher], darwin), undefined);
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform: 'linux', app }));
    assert.equal(selectedAppBuild([launcher], darwin), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shared client: an app update restarts the original server once and asks the model to rerun', async () => {
  const space = workspace();
  const log = captureLog();
  const bridge = sharedClient(space, log);
  try {
    await bridge.connect();
    const before = await bridge.call('js', { code: 'x' }, turn);
    assert.equal(text(before), `${space.starts()[0]}:x`);
    space.setBuild('build-2');
    const replaced = await bridge.call('js', { code: 'pipe-failure' }, turn);
    assert.equal(replaced.isError, true);
    assert.equal(text(replaced), APP_UPDATED_RESTART_TEXT);
    assert.match(text(replaced), /ChatGPT app was updated.*restarted computer use.*kernel reset.*rerun your request/);
    // Never retried: the failing request reached only the old server.
    assert.equal(space.calls('pipe-failure').length, 1);
    const starts = space.starts();
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0], starts[1]);
    // The fresh server is connected, lists its tools and serves later calls.
    assert.deepEqual(bridge.publicTools().map(tool => tool.name), ['js', 'js_reset']);
    assert.equal(text(await bridge.call('js', { code: 'y' }, turn)), `${starts[1]}:y`);
    // The turn continues under a fresh upstream id, as after js_reset.
    const turns = space.calls('y').map(entry => entry.turn);
    assert.notEqual(turns[0], turn.turnId);
    await bridge.turnEnded(turn);
    assert.ok(log.events.some(entry => entry.event === 'upstream_restart' && entry.outcome === 'ok' &&
      entry.cause === 'app_updated'));
    assert.ok(log.events.some(entry => entry.event === 'upstream_close' && entry.cause === 'app_updated'));
  } finally {
    await bridge.close();
    space.remove();
  }
});

test('shared client: a thrown native pipe failure after an app update restarts too', async () => {
  const space = workspace();
  const bridge = sharedClient(space);
  try {
    await bridge.connect();
    space.setBuild('build-2');
    const replaced = await bridge.call('js', { code: 'pipe-throw' }, turn);
    assert.equal(text(replaced), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.starts().length, 2);
  } finally {
    await bridge.close();
    space.remove();
  }
});

test('shared client: with the app build unchanged the original failure passes through', async () => {
  const space = workspace();
  const log = captureLog();
  const bridge = sharedClient(space, log);
  try {
    await bridge.connect();
    const result = await bridge.call('js', { code: 'pipe-failure' }, turn);
    assert.equal(text(result), `Error: ${NATIVE_PIPE_FAILURE}`);
    await assert.rejects(bridge.call('js', { code: 'pipe-throw' }, turn), new RegExp(NATIVE_PIPE_FAILURE));
    assert.equal(space.starts().length, 1);
    assert.ok(!log.events.some(entry => entry.event.startsWith('upstream_restart')));
  } finally {
    await bridge.close();
    space.remove();
  }
});

test('shared client: concurrent failures share one restart', async () => {
  const space = workspace();
  const log = captureLog();
  const bridge = sharedClient(space, log);
  try {
    await bridge.connect();
    space.setBuild('build-2');
    const results = await Promise.all([1, 2, 3].map(index => bridge.call('js', { code: 'slow-pipe-failure' },
      { sessionId: `session-${index}`, turnId: `turn-${index}` })));
    for (const result of results) assert.equal(text(result), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.calls('slow-pipe-failure').length, 3);
    assert.equal(space.starts().length, 2);
    assert.equal(log.events.filter(entry => entry.event === 'upstream_restart').length, 1);
  } finally {
    await bridge.close();
    space.remove();
  }
});

test('shared client: a fresh server that fails the same way is not restarted again', async () => {
  const space = workspace();
  const bridge = sharedClient(space);
  try {
    await bridge.connect();
    space.setBuild('build-2');
    assert.equal(text(await bridge.call('js', { code: 'pipe-failure' }, turn)), APP_UPDATED_RESTART_TEXT);
    // Same build as the fresh server started with: its own error, no restart loop.
    assert.equal(text(await bridge.call('js', { code: 'pipe-failure' }, turn)), `Error: ${NATIVE_PIPE_FAILURE}`);
    assert.equal(text(await bridge.call('js', { code: 'pipe-failure' }, turn)), `Error: ${NATIVE_PIPE_FAILURE}`);
    assert.equal(space.starts().length, 2);
    // js_reset never restarts, whatever it returns.
    await bridge.call('js_reset', {}, turn);
    assert.equal(space.starts().length, 2);
    // Another app update is another change: one more restart.
    space.setBuild('build-3');
    assert.equal(text(await bridge.call('js', { code: 'pipe-failure' }, turn)), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.starts().length, 3);
  } finally {
    await bridge.close();
    space.remove();
  }
});

test('shared client: a restart that cannot start a fresh server reports it on every later call', async () => {
  const space = workspace();
  const log = captureLog();
  const bridge = sharedClient(space, log);
  try {
    await bridge.connect();
    space.setBuild('build-2');
    writeFileSync(join(space.directory, 'fail-start'), '');
    const failed = await bridge.call('js', { code: 'pipe-failure' }, turn);
    assert.equal(failed.isError, true);
    assert.match(text(failed), /^The ChatGPT app was updated, and LCU could not restart computer use \(.+\); restart the LCU MCP server/);
    const later = await bridge.call('js', { code: 'x' }, turn);
    assert.match(text(later), /could not restart computer use/);
    assert.equal(space.calls('x').length, 0);
    assert.equal(await bridge.turnEnded(turn), undefined);
    assert.ok(log.events.some(entry => entry.event === 'upstream_restart' && entry.outcome === 'error'));
  } finally {
    await bridge.close();
    space.remove();
  }
});

/** Start a relay (claude.mjs or codex.mjs) over stdio on the fixture, with the test's app build file. */
async function startRelay(space, relayPath, exportName) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: space.directory,
    TMPDIR: space.directory,
    LCU_FIXTURE_LOG: space.logPath,
    LCU_LOG_DIR: join(space.directory, 'diagnostics'),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--input-type=module', '-e',
      `import { readFileSync } from 'node:fs';` +
      `import { ${exportName} } from ${JSON.stringify(pathToFileURL(relayPath).href)};` +
      `await ${exportName}({ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixture)}], ` +
      `appBuild: () => readFileSync(${JSON.stringify(space.build)}, 'utf8') });`],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'app-update-relay-test', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const diagnostics = () => {
    const directory = env.LCU_LOG_DIR;
    return existsSync(directory) ? readdirSync(directory).flatMap(name =>
      readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))) : [];
  };
  return { client, diagnostics, get stderr() { return stderr; } };
}

let toolUse = 0;
/** One Claude js call with its PreToolUse identity bound first, as the Claude host does. */
async function claudeCall(client, code, { sessionId = 'session-update', turnId = 'prompt-update' } = {}) {
  const toolUseId = `toolu_update_${++toolUse}`;
  await client.callTool({ name: 'set_turn_context', arguments: {
    session_id: sessionId, turn_id: turnId, tool_use_id: toolUseId,
  } });
  return client.callTool({ name: 'js', arguments: { code }, _meta: { 'claudecode/toolUseId': toolUseId } });
}

test('Claude relay: an app update restarts the original server and the relay keeps serving', async () => {
  const space = workspace();
  const relay = await startRelay(space, claudeRelay, 'runClaudeBridge');
  try {
    assert.equal(text(await claudeCall(relay.client, 'x')), `${space.starts()[0]}:x`);
    space.setBuild('build-2');
    const replaced = await claudeCall(relay.client, 'pipe-failure');
    assert.equal(replaced.isError, true);
    assert.equal(text(replaced), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.calls('pipe-failure').length, 1);
    const starts = space.starts();
    assert.equal(starts.length, 2);
    const tools = (await relay.client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes('js') && tools.includes('js_reset') && tools.includes('turn_ended'));
    assert.equal(text(await claudeCall(relay.client, 'y')), `${starts[1]}:y`);
    // The prompt's turn continues under a fresh upstream id on the fresh server, and its Stop reaches that server.
    assert.notEqual(space.calls('y')[0].turn, 'prompt-update');
    const stop = await relay.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'session-update', turn_id: 'prompt-update',
    } });
    assert.equal(stop.isError, undefined);
    const ended = space.records().filter(entry => entry.type === 'call' && entry.name === 'turn_ended');
    assert.equal(ended.at(-1).pid, starts[1]);
    assert.equal(ended.at(-1).args.turn_id, space.calls('y')[0].turn);
    // Unchanged build since the fresh start: the original error passes through.
    assert.equal(text(await claudeCall(relay.client, 'pipe-failure')), `Error: ${NATIVE_PIPE_FAILURE}`);
    assert.equal(space.starts().length, 2);
    const events = relay.diagnostics();
    assert.equal(events.filter(entry => entry.event === 'upstream_restart' && entry.outcome === 'ok').length, 1);
    assert.equal(events.filter(entry => entry.event === 'upstream_connect' && entry.ok).length, 2);
  } finally {
    await relay.client.close();
    space.remove();
  }
});

test('Claude relay: unchanged build passes through, and concurrent failures share one restart', async () => {
  const space = workspace();
  const relay = await startRelay(space, claudeRelay, 'runClaudeBridge');
  try {
    assert.equal(text(await claudeCall(relay.client, 'pipe-failure')), `Error: ${NATIVE_PIPE_FAILURE}`);
    assert.equal(space.starts().length, 1);
    space.setBuild('build-2');
    const results = await Promise.all([1, 2].map(index => claudeCall(relay.client, 'slow-pipe-failure',
      { sessionId: `session-${index}`, turnId: `prompt-${index}` })));
    for (const result of results) assert.equal(text(result), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.starts().length, 2);
  } finally {
    await relay.client.close();
    space.remove();
  }
});

test('Claude relay: a call still running on the server a restart closes shares that restart', async () => {
  const space = workspace();
  const relay = await startRelay(space, claudeRelay, 'runClaudeBridge');
  try {
    space.setBuild('build-2');
    const held = claudeCall(relay.client, 'hold', { sessionId: 'session-held', turnId: 'prompt-held' });
    while (space.calls('hold').length === 0) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(text(await claudeCall(relay.client, 'pipe-failure')), APP_UPDATED_RESTART_TEXT);
    assert.equal(text(await held), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.starts().length, 2);
  } finally {
    await relay.client.close();
    space.remove();
  }
});

test('Codex relay: a call still running on the server a restart closes shares that restart', async () => {
  const space = workspace();
  const relay = await startRelay(space, codexRelay, 'runCodexBridge');
  const meta = turn => ({ 'x-codex-turn-metadata': { session_id: 'codex-session', turn_id: turn } });
  try {
    space.setBuild('build-2');
    const held = relay.client.callTool({ name: 'js', arguments: { code: 'hold' }, _meta: meta('held') });
    while (space.calls('hold').length === 0) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(text(await relay.client.callTool({ name: 'js', arguments: { code: 'pipe-failure' },
      _meta: meta('failing') })), APP_UPDATED_RESTART_TEXT);
    assert.equal(text(await held), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.starts().length, 2);
  } finally {
    await relay.client.close();
    space.remove();
  }
});

test('shared client: a call still running on the server a restart closes shares that restart', async () => {
  const space = workspace();
  const bridge = sharedClient(space);
  try {
    await bridge.connect();
    space.setBuild('build-2');
    const held = bridge.call('js', { code: 'hold' }, { sessionId: 'session-held', turnId: 'turn-held' });
    while (space.calls('hold').length === 0) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(text(await bridge.call('js', { code: 'pipe-failure' }, turn)), APP_UPDATED_RESTART_TEXT);
    assert.equal(text(await held), APP_UPDATED_RESTART_TEXT);
    assert.equal(space.starts().length, 2);
  } finally {
    await bridge.close();
    space.remove();
  }
});

test('Codex relay: an app update restarts the original server and registers module directories again', async () => {
  const space = workspace();
  const relay = await startRelay(space, codexRelay, 'runCodexBridge');
  const meta = { 'x-codex-turn-metadata': { session_id: 'codex-session', turn_id: 'codex-turn' } };
  try {
    await relay.client.callTool({ name: 'js_add_node_module_dir', arguments: { path: '/opt/fixture-modules' } });
    assert.equal(text(await relay.client.callTool({ name: 'js', arguments: { code: 'pipe-failure' }, _meta: meta })),
      `Error: ${NATIVE_PIPE_FAILURE}`);
    assert.equal(space.starts().length, 1);
    space.setBuild('build-2');
    const replaced = await relay.client.callTool({ name: 'js', arguments: { code: 'pipe-failure' }, _meta: meta });
    assert.equal(replaced.isError, true);
    assert.equal(text(replaced), APP_UPDATED_RESTART_TEXT);
    const starts = space.starts();
    assert.equal(starts.length, 2);
    const registered = space.records().filter(entry => entry.type === 'call' && entry.name === 'js_add_node_module_dir');
    assert.deepEqual(registered.map(entry => [entry.pid, entry.args.path]),
      [[starts[0], '/opt/fixture-modules'], [starts[1], '/opt/fixture-modules']]);
    // Closing the replaced server did not close the relay.
    assert.equal(text(await relay.client.callTool({ name: 'js', arguments: { code: 'y' }, _meta: meta })), `${starts[1]}:y`);
    assert.ok((await relay.client.listTools()).tools.some(tool => tool.name === 'js'));
    assert.equal(relay.diagnostics().filter(entry => entry.event === 'upstream_restart' && entry.outcome === 'ok').length, 1);
  } finally {
    await relay.client.close();
    space.remove();
  }
});
