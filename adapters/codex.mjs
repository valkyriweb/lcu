import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ElicitRequestSchema, ListToolsRequestSchema,
  ProgressNotificationSchema, ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { persistAudioContent } from './audio-files.mjs';
import {
  APPROVAL_TIMEOUT_MS, CONNECT_TIMEOUT_MS, callTimeout, callWithDeadline, createApprovalGate,
  createApprovalLogger, createCallTracker, isMainModule, nativeAppApprovalOptions, relayElicitation,
} from './client.mjs';
import { openDiagnosticLog } from './diagnostics.mjs';
import { declineAgentHostApp } from './host-guard.mjs';
import { assertMetadata, readMetadata, serverMetadata } from './metadata.mjs';
import { createRuntimeLifetime, idleTimeout } from './runtime-lifetime.mjs';

const HOST_ONLY_TOOLS = new Set(['js_add_node_module_dir', 'turn_ended']);
function report(label, error) {
  console.error(`${label}:`, error instanceof Error ? error.message : String(error));
}

/** Relay original contracts from explicit setup; execution remains entirely in the original server. */
export async function runCodexBridge({ command, args = [], cwd, env = process.env,
  log = openDiagnosticLog({ adapter: 'codex' }) } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Codex bridge requires the original MCP command and string arguments');
  }
  const selected = [command, ...args];
  let metadata;
  let server;
  try { metadata = await readMetadata(selected, { env }); }
  catch (error) { report('LCU is using eager startup', error); }
  const approvals = createApprovalGate();
  const calls = createCallTracker(log);
  const approvalLog = createApprovalLogger(log, calls);
  const progressHandlers = new Map();
  let nextProgressToken = 0;
  const lifetime = createRuntimeLifetime(async () => {
    const upstream = new Client({ name: 'lcu-codex-relay', version: '0.1.0' }, {
      capabilities: { elicitation: { form: {}, url: {} } },
    });
    let intentionalClose = false;
    upstream.onclose = () => {
      if (!intentionalClose && server) void server.close().catch(error => report('Codex MCP relay close failed', error));
    };
    upstream.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const refused = declineAgentHostApp(request.params);
      const entry = approvalLog.open(refused ? 'agent_host_refused'
        : nativeAppApprovalOptions(request.params) ? 'native_app' : 'other', request.params);
      let response = refused;
      if (!response) {
        try { response = await relayElicitation(server, approvals, request.params, extra.signal); }
        catch { response = { action: 'cancel' }; }
      }
      entry.end(response);
      return response;
    });
    // Keep progress handlers until each call settles, including notifications adjacent to its response.
    upstream.setNotificationHandler(ProgressNotificationSchema, async notification => {
      const { progressToken, ...progress } = notification.params;
      await progressHandlers.get(progressToken)?.(progress);
    });
    upstream.setNotificationHandler(ToolListChangedNotificationSchema, async notification => {
      if (server) await server.notification(notification);
    });
    upstream.onerror = error => report('Codex MCP relay upstream error', error);
    const started = Date.now();
    try {
      await upstream.connect(new StdioClientTransport({ command, args, cwd, env, stderr: 'inherit' }),
        { timeout: CONNECT_TIMEOUT_MS });
      const actual = await serverMetadata(upstream);
      if (metadata) assertMetadata(actual, metadata);
      else metadata = actual;
      log.event('upstream_connect', { ms: Date.now() - started, ok: true });
      return {
        upstream,
        async close() {
          intentionalClose = true;
          await upstream.close();
          log.event('upstream_close');
        },
      };
    } catch (error) {
      log.event('upstream_connect', { ms: Date.now() - started, ok: false });
      intentionalClose = true;
      await upstream.close();
      throw error;
    }
  }, { timeout: idleTimeout(env), onError: error => report('Codex MCP idle close failed', error) });

  if (!metadata) await lifetime.run(() => {});
  const originalCapabilities = metadata.capabilities ?? {};
  if (!originalCapabilities.tools) {
    await lifetime.close();
    throw new Error('Original CUA server does not advertise tools');
  }
  server = new Server(metadata.serverInfo ?? { name: 'lcu-codex-relay', version: '0.1.0' }, {
    capabilities: { tools: originalCapabilities.tools.listChanged ? { listChanged: true } : {} },
    ...(metadata.instructions !== undefined ? { instructions: metadata.instructions } : {}),
  });
  server.onerror = error => report('Codex MCP relay server error', error);
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const listed = await lifetime.run(({ upstream }) => upstream.listTools(request.params, { signal: extra.signal }),
      { startIfMissing: false, activity: false });
    return listed ? { ...listed, tools: listed.tools.filter(tool => !HOST_ONLY_TOOLS.has(tool.name)) }
      : { tools: metadata.tools.filter(tool => !HOST_ONLY_TOOLS.has(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { params } = request;

    if (!HOST_ONLY_TOOLS.has(params.name) && lifetime.resetPending && params.name !== 'js_reset') {
      lifetime.acknowledgeReset();
      return { isError: true, content: [{ type: 'text', text: 'LCU released the idle computer-use runtime. ' +
        'JavaScript bindings and handles were reset. Repeat the original first-invocation entry point before continuing.' }] };
    }
    if (!HOST_ONLY_TOOLS.has(params.name)) lifetime.acknowledgeReset();
    return await lifetime.run(async ({ upstream }) => {
      const progressSends = [];
      let upstreamParams = params;
      const downstreamProgressToken = extra._meta?.progressToken;
      let upstreamProgressToken;
      if (downstreamProgressToken !== undefined) {
        upstreamProgressToken = `lcu-codex-${++nextProgressToken}`;
        upstreamParams = { ...params, _meta: { ...params._meta, progressToken: upstreamProgressToken } };
        progressHandlers.set(upstreamProgressToken, progress => {
          const send = extra.sendNotification({ method: 'notifications/progress',
            params: { ...progress, progressToken: downstreamProgressToken } })
            .catch(error => report('Codex MCP progress relay error', error));
          progressSends.push(send);
          return send;
        });
      }
      try {
        const callUpstream = () => callWithDeadline(approvals, callTimeout(params.name, params.arguments),
          extra.signal, signal => upstream.callTool(upstreamParams, undefined, { signal, timeout: APPROVAL_TIMEOUT_MS }));
        const result = HOST_ONLY_TOOLS.has(params.name) ? await callUpstream()
          : await calls.track(params.name, { timeout_ms: params.arguments?.timeout_ms, signal: extra.signal }, callUpstream);
        return persistAudioContent(result);
      } finally {
        if (upstreamProgressToken !== undefined) progressHandlers.delete(upstreamProgressToken);
        await Promise.all(progressSends);
      }
    }, { startIfMissing: params.name !== 'turn_ended', activity: !HOST_ONLY_TOOLS.has(params.name) }) ?? { content: [] };
  });

  let serverClose;
  const closeDownstream = () => {
    if (!serverClose) serverClose = server.close();
    return serverClose;
  };
  server.onclose = () => { void lifetime.close().catch(error => report('Codex MCP upstream close failed', error)); };
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await lifetime.close(); throw error; }
  // The SDK stdio server does not report stdin EOF through onclose.
  process.stdin.once('end', closeDownstream);
  return {
    server,
    get upstream() { return lifetime.current?.upstream; },
    close: async () => {
      process.stdin.off('end', closeDownstream);
      await closeDownstream();
      await lifetime.close();
    },
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: codex.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
  await runCodexBridge({ command, args });
}
if (isMainModule(import.meta.url)) main().catch(error => {
  report('Codex MCP relay failed', error);
  process.exitCode = 1;
});
