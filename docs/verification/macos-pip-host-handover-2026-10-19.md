# macOS capture indicator and preview host, 2026-10-19

Follow-up to [issue #45](https://github.com/amontlabs/lcu/issues/45) and the
[sharing indicator record](macos-sharing-indicator-2026-09-27.md). Question:
can LCU show the original purple capture indicator (and the original preview)
the same way whether the ChatGPT app is closed, open, or opened or quit during
an LCU run?

No LCU code changed. Live checks ran on the maintainer's Mac with the user's
go-ahead: Finder `getApp`/`getScreenshot` through LCU (installed 0.11.4, fresh
stdio servers), menu bar captures, helper logs, and throwaway preview-host
prototypes run from `/tmp` using only the installed app's files in place.
Extracted app source stayed in private temporary directories. Names identify
evidence, not compatibility allowlists.

## Inputs

- ChatGPT `26.1007.71326`, updated by the app itself on quit to
  `26.1013.40934` (the reporter's version); most results below are on
  `26.1013.40934`.
- Helper `Codex Computer Use.app` build `1001425`, Team `2DC432GLL2`: the
  bundled copy LCU launches, and the copy the app makes in
  `~/.codex/computer-use/`.

## The deciding fact: who owns the helper

The helper logs its lifecycle mode at startup:

| Started by | Logged mode |
| --- | --- |
| The ChatGPT app (normal or `open -g -j` launch) | `Mode.codexManaged(ownerProcessIdentifier: <ChatGPT pid>)` |
| LCU's client (LaunchServices), or the app's own `sky.node` `spawnComputerUseService` called from the app's signed `node` | `Mode.standalone` |

The helper's strings name the check (`parentProcessIsCodex`). A standalone
helper refused every preview host we tried:

| Prototype host (app's signed `node` + `objc-js` AppKit loop + `sky.node`) | Result |
| --- | --- |
| Connect to an LCU-launched helper, inside the Claude Code tool sandbox | Handshake Apple event arrived without its port |
| Same, outside the sandbox (Claude terminal) | `Sender process is not authenticated` |
| Host spawns the helper itself, then connects (the app's order), Claude terminal | Same; helper still `standalone` |
| Same from Terminal.app with its permissions granted | Same |

In each case `startRemoteHostedPIPContentHost` and
`connectRemoteHostedPIPContentHost` returned `true`, macOS granted the Apple
events, and the helper itself returned the error (the string is in the helper,
not in `sky.node`). The issue's `false` came from its inputs.

So the preview host works only with a helper owned by the running ChatGPT
app. LCU can't become that owner: the parent check names the app, and faking
it is out of scope. LCU can use the real app as the owner.

## Live results

| Case | Helper in use | Indicator |
| --- | --- | --- |
| ChatGPT closed | LCU-launched, standalone | Off |
| ChatGPT running, its helper holds the socket | app-owned | **On** after one LCU screenshot; off 4–10 s after LCU turn end (`js_reset`) |
| ChatGPT launched by LCU-side `open -g -j -a ChatGPT` | app-owned | **On**; off ~10 s after turn end. The app still put its main window on screen |
| ChatGPT opened while an LCU helper held the socket | LCU's; the app's second helper waits | Off (seen twice) |
| ChatGPT quit while LCU used its helper | app helper exits with the app; LCU's next call starts a standalone helper 2 s later and the same session continues | Off afterwards; no failed call |
| ChatGPT quit while LCU used its own helper | LCU's | Off; all 14 calls succeeded |
| ChatGPT updated itself on quit | new helper | Every call from already-running LCU servers failed (`Sky Computer Use native pipe startup failed`; helper: `Sender process is not authenticated`). A freshly started server worked |

No preview window appeared for LCU threads under the app's host; the app's
"Always hide Picture in Picture" setting and its anchoring rules govern it.

## Static findings

- LCU's client connects to whichever helper holds `computeruse.sock` and
  launches the bundled helper only when none answers.
- The app never adopts an existing helper; it spawns its own copy and connects
  its preview host only to that helper. A waiting app helper takes the socket
  once the other helper exits (seen live).
- The app starts its host even with "Always hide Picture in Picture" on; that
  setting only hides presentations.
- A standalone helper exits on its own after LCU sessions go idle; an
  app-owned helper exits with the app.

## Conclusions

1. The indicator needs a helper owned by the running ChatGPT app. Standalone
   helpers refuse preview hosts, so an LCU-built host can't work.
2. With an app-owned helper in use, LCU already gets the original indicator,
   ended correctly at turn end, and survives the app quitting mid-session.
3. Start order decides which helper is in use, so the indicator is inconsistent
   even with ChatGPT open. With an LCU helper holding the socket, ChatGPT's own
   computer-use requests may reach LCU's helper; not tested.
4. Separate bug: after the app updates itself, already-running LCU servers keep
   the old signed code and the new helper rejects them until each restarts.

## Proposed changes

1. **Prefer the app-owned helper.** When the ChatGPT app is running and an
   LCU-launched standalone helper holds the socket, release it at a point with
   no active LCU turn so the app's waiting helper takes over. Coordinate across
   LCU servers with the existing per-account lock and process-identity checks.
2. **Opt-in app host.** With an explicit setting, when no app-owned helper is
   running, LCU launches the installed app in the background
   (`open -g -j -a ChatGPT`) before its first native request, so the indicator
   behaves the same whether the user had the app open or not. Default off: it
   puts the app's window on screen.
3. **Restart after an app update.** When a request fails with the original
   native-pipe error and the selected app's executables changed on disk since
   the LCU server started, restart LCU's own runtime from the current app and
   retry once.
4. **Docs and issue reply.** The indicator and preview come from the ChatGPT
   app's host: they appear while an app-owned helper is in use (and with the
   opt-in, LCU starts the app for that).

## Still untested

- ChatGPT's own computer use while an LCU-launched helper holds the socket.
- Whether the app can be kept from showing its window when LCU launches it.
- Why no preview window appeared for LCU threads under the app's host.
