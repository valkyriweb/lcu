# Lazy adapter startup and idle release — 2026-10-10

## Scope and evidence boundary

This change reduces eager LCU runtime lifetime in Pi (including its OMP wrapper) and Codex. The diagnosis found eager helpers beneath live sessions; it did **not** establish a terminated-session leak. This record does not claim such a leak is fixed.

No personal-desktop test, installation over an existing prefix, or termination of an existing helper was performed. Native macOS and Windows idle-release behavior remains unverified. Synthetic child-process tests prove adapter transport/lifetime ownership, not the original native host's teardown behavior.

## Official-source evidence

Read-only inspection of locally installed ChatGPT **26.1007.21159**, macOS arm64:

- `cua_node/lib/node_modules/@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/index.js` exports only `launch`. SHA-256: `bbc0c68a1520d72d1431233bf1c4fd9e3520776cde48542b20332f8ba9da3760`.
- The adjacent `launch.js` selects original instructions through the platform and `CUA_REPL_*` configuration, constructs `NODE_REPL_TOOL_OVERRIDES`, and starts the original `node_repl`. SHA-256: `3e52a41f4da41d35be8cc3723fe97251711087a998c1ed7f2cfdf7e20b50fc2b`.
- There is no metadata-only export in that entry point. LCU therefore captures initialization and tool-list responses through the official MCP SDK during explicit setup instead of copying instructions or reconstructing schemas.

These hashes identify observations, not compatibility allowlists. No original instruction text, generated fragment or app binary was added to the repository.

## Deliberate adaptations

- Setup captures original server identity, capabilities, instructions and descriptors into an account-private cache. Its key includes app/runtime versions, configuration, launch command and source identities. POSIX file mode is `0600`; the cache directory is `0700`.
- Valid snapshots permit zero upstream spawns during initialization, discovery and unused turns. Missing or stale snapshots issue one warning and fall back to the previous eager behavior. They **do not fail closed or disable computer use**.
- An idle timer defaults to ten minutes and closes only when no startup, call, approval or cleanup operation is leased. A later call can start a new generation; session shutdown drains existing leases. Cleanup without a generation never starts one.
- Idle expiry resets JavaScript state. The next `js` receives an explicit reset error without running its code; the following call can repeat the official first-invocation entry point. `js_reset` can restart directly. Original descriptors and prompt bytes remain unchanged.
- A contract change after a session has already advertised its metadata requires setup refresh and session restart. LCU does not silently execute against different descriptors.

## Deterministic checks

Unit checks run in disposable Linux ARM64 Docker containers with the checkout mounted read-only and copied into `/work`. Native integration uses the repository's disposable desktop containers. No model provider or personal credential is used.

On Node **24.11.1** in the repository's Ubuntu verification image:

- `node --test --import ./test/no-diagnostic-log.mjs test/*.test.mjs` (from `adapters/`): **146 passed, 8 skipped, 0 failed**.
- `node --test tests/node/*.test.mjs`: **412 passed, 6 skipped, 0 failed**.
- `python3 -m unittest discover -b -s tests -p 'test_*.py'` (Python **3.12.3**, adapter dependencies installed): **20 passed, 18 skipped, 0 failed**.
- Focused lifecycle/Pi/OMP/Codex suites also passed **37/37** on Node **22.23.3** in a disposable `node:22-alpine` container. This is adapter compatibility evidence, not support for the original runtime on musl.
- The cached-unused-session tests were run against the original Pi and Codex adapter files from base `c1693ae942b417bb297d41ce440123f5f4eec01f`, with the same synthetic fixture and new test infrastructure. Both failed at the intended zero-spawn assertion: an MCP process and its helper had started. Both pass with the lifetime changes.

An initial tooling run used Python 3.11, below the documented 3.12 minimum, and failed on unsupported syntax/tar APIs. A second Python run lacked installed adapter dependencies. The correctly prepared Ubuntu image passed; those setup errors are not product failures.

Primary regressions in `adapters/test/lazy-lifetime.test.mjs` use a synthetic MCP process that owns a separate helper process. They check actual PIDs for:

1. Setup capture closes both processes; cached discovery and unused turns spawn neither.
2. First tool use starts one generation; idle expiry removes both owned processes.
3. Reset notification and a fresh generation after idle.
4. Missing and configuration-stale snapshots retain working eager computer use and warn once.
5. In-flight calls outlast the configured idle timeout; shutdown removes owned processes.
6. Private cache permissions, original descriptor/instruction preservation, and configuration binding.

`runtime-lifetime.test.mjs` uses deterministic deferred promises and mock timers to check concurrent startup, shutdown during startup, serialized close/restart, and refusal to duplicate a generation after failed cleanup. Existing Pi cleanup retry, picker, approval, OMP prompt sections, Codex progress ordering and result-forwarding regressions remain in the adapter suite.

## Real integration gate

`bash tests/run.sh linux/arm64` runs in the repository's disposable desktop containers. The first attempt built the verification image but stopped while building the archive because this newly linked record had not yet been written. That was a work-in-progress ordering error, not runtime evidence.

The next attempt built the archive, completed offline installation/registration and multiple native desktop passes, including GTK through the Codex relay with the expected missing-cache eager fallback warning. It later failed in the unchanged `gtk4_input.py` drag oracle: its output file was empty where coordinates were expected. This full gate was **not green**; no conclusion about that failure's root cause is claimed.

The gate now additionally runs `tests/adapter_lifetime.mjs` against the installed original runtime in its disposable X11 account. It captures real setup metadata, checks unused Pi/Codex initialization and shutdown, calls `cua.getState()`, observes the original runtime/helper process command lines in `/proc`, waits for idle teardown, restarts, and checks shutdown. Existing processes are excluded and never killed by the test. This is deterministic, with no model provider.

An earlier successful gate returned **exit 0**. Its later desktop passes included the strengthened process oracle, which explicitly requires and observes the original architecture-suffixed Sky engine (`sky_linux_arm64`) along with Node helpers, and verifies their disappearance. Pi and Codex each passed cached unused initialization, real `getState`, idle teardown, reset notification, restart and shutdown. The earlier GTK4 failure did not recur; its cause remains undiagnosed.

That earlier archive predated the passive-traffic refinement. A subsequent **exact-final-implementation packaged rerun passed, exit 0**, including the refinement and the strengthened Sky-engine probe throughout. All three desktop passes passed both Pi and Codex lifecycle checks (5/8/8 matching runtime/helper command lines, including sandbox wrappers). The unchanged GTK4 test also passed. Existing gate skips remain: this original engine has no key-down/key-up pass-through, and some cross-PID-namespace probes could not execute in this container configuration.

The rerun reused the unchanged verification image `sha256:693f67aa878790a9991e77fb88313c79422a4150e3ae40ef7800d8e6e2bbee93`. It serialized every container, each with `--cpus=2`, `MAKEFLAGS=-j2`, `CMAKE_BUILD_PARALLEL_LEVEL=2` and `npm_config_jobs=2`. No image rebuild or parallel unit container ran. The command was `bash tests/run.sh linux/arm64 <previous-gate>/upstream.deb`, through a temporary Docker wrapper that reused that image and applied those limits.

Local receipts:

- Gate log: `/tmp/lcu-lazy-idle-a3-exact-tree.log`.
- Archive: `.verification/arm64.YUBl2C/lcu-0.10.1-linux-arm64.tar.gz`.
- Archive SHA-256: `f76ca4567d6f17ca9c18caf82247c62d8f021f03c2fb0b5d448d3701bbea9401`.
- Source/archive comparison: `/tmp/lcu-a3-package-source-receipt.json`.

Every changed packaged implementation file matches the final source byte-for-byte. The source-only tests and packaging script remained unchanged during the run. **Only this verification document was amended after packaging**, to record results and the proposed installation commands below; no implementation or test changes followed the exact-tree gate.

No new real macOS or Windows integration claim is made. Existing platform evidence remains unchanged.

## Proposed macOS build beside the existing installation — not executed

The installer usage and `scripts/install.mjs` confirm that macOS accepts `--prefix`, `--existing-app`, `--runtime-only` and `--yes`. `checkedPrefix` requires a dedicated absolute path outside the extracted release, with no linked components. The macOS branch passes that prefix to `installMac`; `--runtime-only` returns before agent registration. Installation validates the original runtime and can execute its validation probes, so this proposal still requires approval before execution.

From the source checkout, with Python 3.12 or newer and a fresh output directory:

```sh
out="$PWD/dist/lazy-idle-candidate"
prefix="$HOME/.local/share/lcu-lazy-idle-candidate"
test ! -e "$out" && test ! -e "$prefix" || exit 1
MAKEFLAGS=-j2 CMAKE_BUILD_PARALLEL_LEVEL=2 npm_config_jobs=2 \
  python3 scripts/build_bundle.py --platform darwin \
  --app /Applications/ChatGPT.app --output "$out"
set -- "$out"/lcu-*-darwin-arm64.tar.gz
test "$#" -eq 1 && test -f "$1" || exit 1
archive="$1"
tar -xzf "$archive" -C "$out"
bundle="${archive%.tar.gz}"
"$bundle/scripts/install.sh" --prefix "$prefix" \
  --existing-app /Applications/ChatGPT.app --runtime-only --yes
```

This deliberately does not run setup or change existing Pi/Codex registrations. The candidate executable would be `$prefix/current/bin/lcu`. Subsequent metadata capture and native validation need separate approval and a dedicated account/profile with matching configuration. Do not remove or stop existing helpers to test the candidate.
