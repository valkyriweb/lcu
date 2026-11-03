"""Drive a real Claude Code CLI through the lcu-approve mod against a fixture runtime.

No model and no credentials: a scripted local Messages API makes the model call
`mcp__lcu__js` once, the Claude relay (adapters/claude.mjs) forwards it to the
original-runtime fixture, which asks the native-app approval and reports the
answer the relay returned. HOME is a temporary directory.

The `desktop` scenarios stand in for the Claude app instead of a terminal: Claude Code runs as the app runs
it (stream-json over stdio, permission requests sent to the host), a `ui_attach` names the desktop surface,
and the driver answers the question card as the app does, with the answer in the tool's updated input.
Without the mcp__lcu allow rule (setup adds none), every other permission request the session sends is
denied, as auto mode's classifier did, and fails the scenario.

    python3 tests/claude_approval_mod.py --claude PATH [--scenario NAME ...]

Needs /usr/bin/expect, Node with `npm ci --prefix adapters`, and a Claude Code
build that has mods (2.1.287 or the Claude app's bundled 2.1.286). Not part of
tests/run.sh. Does not touch the real home directory or computer use.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call  # noqa: E402

PROMPT = 'Run the approval check.'
KEY = 'sk-ant-api03-' + 'x' * 40

SESSION = {'action': 'accept', 'content': {}, '_meta': {'persist': 'session'}}
ALWAYS = {'action': 'accept', 'content': {}, '_meta': {'persist': 'always'}}
DIALOG = r'Allow.?this.?conversation'


def scenario(pattern=DIALOG, *, mod=True, columns=160, code='approval-native', keys=(), answer=None,
             surface='pane', delay=3, tool='mcp__lcu__js', model_call=None, screen=None, headless=False,
             desktop=False, attach=True):
    return dict(pattern=pattern, mod=mod, columns=columns, code=code, keys=list(keys), answer=answer,
                surface=surface, delay=delay, tool=tool, model_call=model_call, screen=screen, headless=headless,
                desktop=desktop, attach=attach)


SCENARIOS = {
    'pane-session': scenario(keys='a', answer=SESSION),
    'pane-always': scenario(keys='l', answer=ALWAYS),
    'pane-deny': scenario(keys='d', answer={'action': 'decline'}),
    'pane-dismiss': scenario(keys=['ESC'], answer={'action': 'cancel'}),
    'pane-session-only': scenario(code='approval-native-session-only', keys='a', answer=SESSION),
    # The person takes longer than a hook's 10 s: no hook waits, so the answer still arrives.
    'pane-slow': scenario(keys='a', answer=SESSION, delay=15),
    # The terminal cannot seat an unasked pane below 144 columns: the question dialog is used.
    'ask-narrow': scenario(columns=100, keys=['ENTER'], answer=SESSION, surface='ask'),
    # Without the mod the engine's own form shows, unchanged.
    'no-mod-form': scenario(r'requests.?your.?input', mod=False, columns=100, keys=['ESC'],
                            answer={'action': 'cancel'}, surface='engine'),
    # No person to ask (`claude -p`): the hook steps aside and the host cancels at once, as without the mod.
    'headless': scenario(mod=True, answer={'action': 'cancel'}, surface='engine', headless=True),
    # The model may not call the host-only tools: the mod refuses, and so does the relay without it.
    'model-call-denied': scenario(r'host-only', tool='mcp__lcu__approval_choice',
                                  model_call={'id': 'x', 'choice': 'always'}, surface='engine', screen='host-only'),
    'model-call-no-mod': scenario(r'host-mod', mod=False, tool='mcp__lcu__approval_choice',
                                  model_call={'id': 'x', 'choice': 'always'}, surface='engine', screen='host-mod'),
    # The Claude app's question card. The choice must reach LCU with no permission request of its own: one
    # sent from a timer bypassed the mod's tool.check, and auto mode refused it (2026-10-20).
    'desktop-session': scenario(answer=SESSION, surface='ask', desktop=True),
    'desktop-slow': scenario(answer=SESSION, surface='ask', desktop=True, delay=75),
    # The app with Claude Code 2.1.304: no surface attached when the approval arrives (2026-10-21).
    'desktop-unattached': scenario(answer=SESSION, surface='ask', desktop=True, attach=False),
}


def prepare(base, claude, name, use_mod, allow_lcu=True):
    home = base / 'home'
    project = base / 'project'
    home.mkdir()
    project.mkdir()
    call('claude_visibility', 'install', home)
    if allow_lcu:
        settings = home / '.claude/settings.json'
        data = json.loads(settings.read_text())
        data['permissions'].setdefault('allow', []).append('mcp__lcu')
        settings.write_text(json.dumps(data, indent=2))
    if use_mod:
        call('claude_mod', 'install', home, ROOT)
    (home / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'numStartups': 5,
        'customApiKeyResponses': {'approved': [KEY[-20:]], 'rejected': []},
        'projects': {str(project): {'hasTrustDialogAccepted': True, 'allowedTools': []}},
    }))
    log = base / 'fixture.jsonl'
    node = shutil.which('node')
    mcp = base / 'mcp.json'
    mcp.write_text(json.dumps({'mcpServers': {'lcu': {
        'command': node,
        'args': [str(ROOT / 'adapters/claude.mjs'), node, str(ROOT / 'adapters/test/claude-fixture.mjs')],
        'env': {'LCU_FIXTURE_LOG': str(log)}}}}))
    return home, project, log, mcp


def drive_desktop(claude, project, env, mcp, debug_file, delay, attach=True):
    """Run Claude Code as the Claude app does and answer its permission requests; return those it denied."""
    command = [claude, '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
               '--permission-prompt-tool=stdio', '--permission-mode', 'default', '--mcp-config', str(mcp),
               '--strict-mcp-config', '--debug-file', str(debug_file)]
    # The app's entrypoint: a remote surface may attach to the session.
    env = {**env, 'CLAUDE_CODE_ENTRYPOINT': 'claude-desktop'}
    process = subprocess.Popen(command, cwd=project, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, bufsize=1)
    denied = []
    lock = threading.Lock()

    def send(message):
        with lock:
            process.stdin.write(json.dumps(message) + '\n')
            process.stdin.flush()

    def answer(request_id, request):
        tool = request.get('tool_name')
        updated = dict(request.get('input') or {})
        if tool == 'AskUserQuestion':
            # The person reads the card, then picks its first option.
            time.sleep(delay)
            question = updated['questions'][0]
            updated['answers'] = {question['question']: question['options'][0]['label']}
        elif tool != 'mcp__lcu__js':
            denied.append(tool)
            send({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request_id,
                  'response': {'behavior': 'deny', 'message': 'Denied by the desktop scenario'}}})
            return
        send({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request_id,
              'response': {'behavior': 'allow', 'updatedInput': updated}}})

    send({'type': 'control_request', 'request_id': 'init', 'request': {'subtype': 'initialize'}})
    if attach:
        send({'type': 'control_request', 'request_id': 'attach',
              'request': {'subtype': 'ui_attach', 'surface': 'desktop', 'client_id': 'lcu-test'}})
    send({'type': 'user', 'message': {'role': 'user', 'content': PROMPT}, 'parent_tool_use_id': None,
          'session_id': ''})
    # A choice that never reaches LCU leaves the call waiting for good: stop the session after a while.
    watchdog = threading.Timer(delay + 90, process.terminate)
    watchdog.start()
    try:
        for line in process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get('type') == 'control_request' and message['request'].get('subtype') == 'can_use_tool':
                threading.Thread(target=answer, args=(message['request_id'], message['request']), daemon=True).start()
            elif message.get('type') == 'control_request' and message['request'].get('subtype') == 'elicitation':
                # The app declines the engine's own form.
                send({'type': 'control_response', 'response': {'subtype': 'success',
                      'request_id': message['request_id'], 'response': {'action': 'decline'}}})
            elif message.get('type') == 'control_request':
                send({'type': 'control_response', 'response': {'subtype': 'success',
                      'request_id': message['request_id'], 'response': {}}})
            elif message.get('type') == 'result':
                break
    finally:
        watchdog.cancel()
        process.stdin.close()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.terminate()
    return denied


def run(claude, name, keep):
    spec = SCENARIOS[name]
    base = Path(tempfile.mkdtemp(prefix='lcu-mod-e2e-')).resolve()
    api = None
    ok = False
    try:
        home, project, log, mcp = prepare(base, claude, name, spec['mod'], allow_lcu=not spec['desktop'])
        port_file = base / 'port'
        api_log = base / 'api.jsonl'
        api = subprocess.Popen(['node', str(ROOT / 'tests/claude_fake_api.mjs'), str(port_file), str(api_log),
                                spec['tool'], json.dumps(spec['model_call'] or {'code': spec['code']})])
        for _ in range(100):
            if port_file.exists():
                break
            time.sleep(0.05)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('CLAUDE', 'ANTHROPIC'))}
        env.update({'HOME': str(home), 'ANTHROPIC_API_KEY': KEY, 'DISABLE_AUTOUPDATER': '1',
                    'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{port_file.read_text()}',
                    'LCU_E2E_DELAY': str(spec['delay']), 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1',
                    # The scripted API answers with a call to the tool it is offered: no deferred tools.
                    'ENABLE_TOOL_SEARCH': 'false'})
        debug_file = base / 'debug.log'
        denied = []
        if spec['desktop']:
            denied = drive_desktop(claude, project, env, mcp, debug_file, spec['delay'], spec['attach'])
            result = subprocess.CompletedProcess([], 0, f'denied permission requests: {denied}', '')
        elif spec['headless']:
            command = [claude, '-p', PROMPT, '--mcp-config', str(mcp), '--strict-mcp-config',
                       '--debug-file', str(debug_file)]
        else:
            command = ['/usr/bin/expect', str(ROOT / 'tests/claude_approval_mod.exp'), str(base / 'terminal.log'),
                       str(spec['columns']), claude, str(project), PROMPT, spec['pattern'],
                       ' '.join(spec['keys']), str(mcp), '--debug-file', str(debug_file)]
        if not spec['desktop']:
            result = subprocess.run(command, cwd=project, env=env, capture_output=True, text=True, timeout=240)
        records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        answers = [item['response'] for item in records if item.get('type') == 'elicitation-response']
        debug = debug_file.read_text(errors='replace') if debug_file.exists() else ''
        surface = ('pane' if re.search(r'\(unasked, \d+ columns\): placed', debug) else
                   'ask' if 'AskUserQuestion' in debug else 'engine')
        if spec['model_call']:
            # What the model was told: the tool result Claude Code sent back to the API.
            told = api_log.read_text() if api_log.exists() else ''
            ok = spec['screen'] in told and answers == []
        else:
            ok = answers == [spec['answer']] and surface == spec['surface'] and denied == []
        print(f'  surface={surface} (expected {spec["surface"]})')
        if denied:
            print(f'  denied permission requests: {denied}')
        print(f'{"PASS" if ok else "FAIL"} {name}: answers={answers}')
        if not ok or keep:
            print(result.stdout[-1500:])
            print(f'  evidence kept in {base}')
        return ok
    finally:
        if api:
            api.terminate()
        if not keep and ok:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', required=True, help='Claude Code executable with mods')
    parser.add_argument('--scenario', action='append', choices=sorted(SCENARIOS))
    parser.add_argument('--keep', action='store_true')
    arguments = parser.parse_args()
    results = [run(arguments.claude, name, arguments.keep) for name in arguments.scenario or SCENARIOS]
    sys.exit(0 if all(results) else 1)
