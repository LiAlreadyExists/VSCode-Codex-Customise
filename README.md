# VSCode-Codex-Customise

Custom TODO triggers, message templates and destination chats for Codex in VS Code.

Requires VS Code 1.96.2 or later, the official Codex extension (`openai.chatgpt`), and a signed-in Codex account.

## Installation

1. Download a `.vsix` file from [Releases](https://github.com/LiAlreadyExists/VSCode-Codex-Customise/releases).
2. In the Extensions panel, select **… → Install from VSIX…** and choose the downloaded file.
3. Run **Codex Customise: Enable Custom TODOs** from the Command Palette.
4. Reload VS Code.

## Configuration

Run **Codex Customise: Configure TODOs** to edit the settings.

- **Trigger:** exact, case-sensitive text to match anywhere on a line. Default: `TODO`.
- **Message:** the prompt template. Leave empty to use the default Codex TODO prompt.
- **Target Thread ID:** the destination chat. Leave empty to create a new chat for each TODO.

Example settings:

```json
{
  "codexCustomise.trigger": "//TASK",
  "codexCustomise.message": "Implement the comment in {relativeFile}:{line}.\n\n{comment}\n\nRemove the comment when finished."
}
```

```ts
//TASK return the sum of the two arguments
function add(a: number, b: number) {}
```

Click **Implement with Codex** above a matching line.

Message templates support:

| Placeholder | Value |
| --- | --- |
| `{comment}` | Unchanged text after the trigger on the same line |
| `{file}` | Absolute file path or document URI |
| `{relativeFile}` | Path relative to the working folder, or document URI |
| `{line}` | One-based line number |
| `{workspace}` | Working folder: workspace folder, file directory, or home directory |

Run **Codex Customise: Select TODO Target Thread** to choose an idle local chat. The selection is saved in settings. Choose **New thread** to reset it.

Custom messages sent to new chats show progress in the **VSCode-Codex-Customise** Output channel. Other actions use the Codex chat interface.

Custom messages and selected-chat runs use workspace-write permissions with network access disabled. These execution settings can carry over to later turns in the selected chat. Existing-chat routing depends on internal Codex APIs and may require updates when Codex changes.

## Restore official TODO actions

Run **Codex Customise: Restore Original TODOs**, then reload VS Code. Do this before disabling or uninstalling the extension.

## Development

Requires Node.js 22 or later and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm compile
pnpm test
pnpm package
```

The VSIX package is written to `releases/`.
