# VSCode-Codex-Customise

Configure TODO comment triggers, message templates and destination threads for Codex in VS Code.

Requires VS Code 1.96.2 or later, the official **Codex – OpenAI’s coding agent** extension (`openai.chatgpt`), and a signed-in Codex account.

## Install

In the Extensions panel, select **… → Install from VSIX…** and choose `VSCode-Codex-Customise-0.1.4.vsix` from `releases/`. Reload VS Code after installation or an update.

Custom TODO actions are disabled by default. Enable them separately for each workspace.

## Configure

1. Open a project folder.
2. Run **Codex Customise: Enable Custom TODOs** from the Command Palette.
3. Reload VS Code to activate the custom TODO actions.
4. Run **Codex Customise: Configure TODOs** to edit the trigger and message template.

Example settings:

```json
{
  "codexCustomise.trigger": "//TASK",
  "codexCustomise.message": "Implement the comment in {relativeFile}:{line}.\n\n{comment}\n\nRemove the comment when finished."
}
```

```ts
//TASK: return the sum of the two arguments
function add(a: number, b: number) {}
```

Click **Implement with Codex** above a matching comment. Trigger matching is literal and case-insensitive. Supported forms include comment text (`TODO`, `FIXME`) and a comment prefix with text (`//TASK`, `#TASK`, `%TODO`). The scanner skips quoted strings and recognizes common comment syntax; it does not fully parse every language.

The Message setting accepts line breaks with Enter. Leave it empty to use the default Codex TODO prompt. Templates support these placeholders:

| Placeholder | Value |
| --- | --- |
| `{comment}` | Comment text after the trigger |
| `{file}` | Absolute file path |
| `{relativeFile}` | Path relative to the workspace folder |
| `{line}` | One-based comment line number |
| `{workspace}` | Absolute workspace folder path |

## Destination thread

Run **Codex Customise: Select TODO Target Thread** and choose an idle local thread. The selection is saved in workspace settings and persists across VS Code restarts and extension updates. Choose **New thread** to create a thread for each TODO. A thread ID can also be entered in `codexCustomise.targetThreadId`.

The selected thread must be available to the official Codex extension in the configured Codex data directory. Each TODO runs in the clicked file’s workspace folder, including when the thread previously used another directory.

| Configuration | Execution and progress |
| --- | --- |
| Default message, new thread | Official Codex TODO action and sidebar |
| Custom message, new thread | Separate Codex process; progress in the **VSCode-Codex-Customise** Output channel |
| Selected thread | Message sent through the app managing that thread; progress and approvals in the selected chat |

Threads created by the separate process can be reopened in Codex. Custom messages and selected-thread runs use a workspace-write sandbox, with network access disabled by default and approval requests shown in VS Code or Codex. These execution settings also apply to later turns in a selected thread. Cancellation interrupts the submitted turn.

## Restore official TODO actions

Run **Codex Customise: Restore Original TODOs**, then reload VS Code. This restores the workspace’s previous `chatgpt.commentCodeLensEnabled` value. Run this command before disabling or uninstalling the extension when custom TODOs are enabled.

## Runtime and compatibility

The extension discovers the Codex executable in the official extension or on `PATH`. Set `codexCustomise.codexPath` to an absolute executable path to override discovery. Set `codexCustomise.codexHome` to use another Codex data directory; otherwise the extension uses `CODEX_HOME` or the Codex default.

Routing to an existing thread uses Codex’s internal, versioned local protocol, tested with `openai.chatgpt` 26.1007.21434. Protocol changes may require an extension update. Cloud-only threads are unsupported.

Thread routing requires a responsive connection to the app managing the chat. App or VS Code restarts can leave that connection unavailable. Connection failures are retried before submission; an unavailable connection stops the action. If delivery cannot be confirmed, check the selected chat before retrying. The extension does not automatically resend an uncertain submission.

## Development

Requires Node.js 22 or later and pnpm. The test fixtures use a POSIX shell and Unix sockets.

```sh
pnpm install --frozen-lockfile
pnpm compile
pnpm test
pnpm package
```

Set `VSCODE_TEST_BINARY` to the VS Code application executable before running the integration tests:

```sh
pnpm test:vscode
```

To test the packaged extension, also set `VSCODE_TEST_CLI` to the VS Code command-line launcher:

```sh
node scripts/test-vscode.cjs --package
```

To test the wire protocol with an installed Codex executable, set `CODEX_TEST_EXECUTABLE`, then run:

```sh
node scripts/test-real-protocol.cjs
```

Integration tests use synthetic files, an isolated Codex home, and separate VS Code settings and extensions. The protocol test uses a synthetic local Responses server. Generated profiles and logs are stored in `.test-runs/` and can be deleted after testing. `pnpm package` writes the installable VSIX to `releases/`.
