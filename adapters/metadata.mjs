import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONNECT_TIMEOUT_MS, isMainModule } from './client.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const refresh = 'Run lcu setup again for this account and computer-use configuration to refresh original MCP metadata.';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function identity(path) {
  const resolved = realpathSync(path);
  const stat = statSync(resolved, { bigint: true });
  return [resolved, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]))];
}

async function binding(command, env) {
  if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string') || !isAbsolute(command[0])) {
    throw new Error('LCU metadata requires an absolute runtime command');
  }
  const files = command.filter(part => isAbsolute(part) && existsSync(part)).map(identity);
  const installation = join(root, 'installation.json');
  let versions;
  if (existsSync(installation)) {
    const { paths } = await import('../lcu/runtime.mjs');
    const selected = paths(root, undefined, { reuseRecordedChecks: true });
    versions = selected.metadata;
    const windows = process.platform === 'win32';
    const modules = join(selected.runtime, windows ? 'bin/node_modules' : 'lib/node_modules');
    const source = join(modules, '@oai/cua-repl');
    files.push(identity(installation), identity(join(selected.runtime, windows ? 'bin/node_repl.exe' : 'bin/node_repl')));
    for (const name of readdirSync(source, { recursive: true }).sort()) {
      const path = join(source, name);
      if (statSync(path).isFile()) files.push(identity(path));
    }
  }
  // These are the original launcher's instruction/schema switches, plus the account and caller overrides.
  // Do not bind PATH, logging, idle duration, or per-turn metadata to model-visible contracts.
  const settings = Object.fromEntries(Object.entries(env).filter(([key]) =>
    (/^(CUA_REPL_|NODE_REPL_|SKY_|BROWSER_USE_)/.test(key) || ['NODE_OPTIONS', 'BUILD_FLAVOR'].includes(key)) &&
    !['NODE_REPL_REQUEST_META', 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS'].includes(key)));
  return canonical({ version: 1, command, platform: process.platform, arch: process.arch,
    home: env.HOME ?? env.USERPROFILE ?? homedir(), codexHome: env.CODEX_HOME, versions, settings, files });
}

function location(configuration, env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.cache/lcu/mcp-metadata', `${digest(configuration)}.json`);
}

function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
    throw new Error(`LCU metadata must be account-private and not a symlink: ${path}`);
  }
}

export async function readMetadata(command, { env = process.env } = {}) {
  try {
    const configuration = await binding(command, env);
    const path = location(configuration, env);
    privatePath(dirname(path), true);
    privatePath(path);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (digest(saved.binding) !== digest(configuration) || !Array.isArray(saved.metadata?.tools) ||
        !saved.metadata.tools.some(tool => tool.name === 'js') || !saved.metadata.tools.some(tool => tool.name === 'js_reset')) {
      throw new Error('metadata is stale or invalid');
    }
    if (saved.metadata.instructions !== undefined && typeof saved.metadata.instructions !== 'string') {
      throw new Error('invalid original instructions');
    }
    for (const tool of saved.metadata.tools) ToolSchema.parse(tool);
    if (!saved.metadata.capabilities?.tools || typeof saved.metadata.serverInfo?.name !== 'string' ||
        typeof saved.metadata.serverInfo?.version !== 'string') throw new Error('invalid original server metadata');
    return saved.metadata;
  } catch (error) {
    throw new Error(`LCU original MCP metadata is unavailable: ${error.message}. ${refresh}`, { cause: error });
  }
}

export async function serverMetadata(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return { instructions: client.getInstructions(), serverInfo: client.getServerVersion(),
    capabilities: client.getServerCapabilities(), tools };
}

export function assertMetadata(actual, expected) {
  if (digest(canonical(actual)) !== digest(canonical(expected))) {
    throw new Error(`Original MCP contracts changed since setup. ${refresh}`);
  }
}

/** Explicit setup only: collect the original protocol, close the runtime, then publish a private snapshot. */
export async function captureMetadata(command, { env = process.env, cwd } = {}) {
  const before = await binding(command, env);
  const client = new Client({ name: 'lcu-metadata-setup', version: '1' }, { capabilities: { elicitation: { form: {}, url: {} } } });
  client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'cancel' }));
  let metadata;
  try {
    await client.connect(new StdioClientTransport({ command: command[0], args: command.slice(1), env, cwd, stderr: 'inherit' }),
      { timeout: CONNECT_TIMEOUT_MS });
    metadata = await serverMetadata(client);
    if (!metadata.capabilities?.tools || !['js', 'js_reset'].every(name => metadata.tools.some(tool => tool.name === name))) {
      throw new Error('Original CUA js/js_reset tools are missing');
    }
  } finally { await client.close(); }
  if (digest(before) !== digest(await binding(command, env))) throw new Error(`Application changed during metadata capture. ${refresh}`);
  const path = location(before, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  privatePath(dirname(path), true);
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify({ binding: before, metadata }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return metadata;
}

if (isMainModule(import.meta.url)) {
  captureMetadata(JSON.parse(process.argv[2])).catch(error => {
    console.error(`LCU metadata setup: ${error.message}`);
    process.exitCode = 1;
  });
}
