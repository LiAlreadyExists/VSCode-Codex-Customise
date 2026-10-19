import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { CodexRpc, JsonObject } from './rpc';
import { buildPrompt, findTodos, TodoContext, usesNativeAction } from './todo';
import { listThreads, runTodo } from './runner';
import { sendToOwner } from './owner';

const namespace = 'codexCustomise';
const nativeSetting = 'commentCodeLensEnabled';
const savedSettingKey = 'originalCodexTodoSetting';
interface LensArgument { uri: string; version: number; offset: number; raw: string }
interface SavedSetting { hadValue: boolean; value?: boolean }
let runningClient: CodexRpc | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('VSCode-Codex-Customise');
  const changed = new vscode.EventEmitter<void>();
  let busy = false;
  let warnedConflict = false;
  const config = (uri?: vscode.Uri) => vscode.workspace.getConfiguration(namespace, uri);
  const configurationTarget = () => vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const savedSettings = () => configurationTarget() === vscode.ConfigurationTarget.Workspace ? context.workspaceState : context.globalState;
  const originalSetting = (native: vscode.WorkspaceConfiguration) => configurationTarget() === vscode.ConfigurationTarget.Workspace
    ? native.inspect<boolean>(nativeSetting)?.workspaceValue : native.inspect<boolean>(nativeSetting)?.globalValue;
  const reportError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`Codex Customise: ${message}`, 'Show Output').then(action => {
      if (action) output.show(true);
    });
  };
  const reloadNotice = () => {
    void vscode.window.showInformationMessage('Reload VS Code to switch TODO actions.', 'Reload Window').then(action => {
      if (action) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  };
  const enable = async () => {
    const native = vscode.workspace.getConfiguration('chatgpt');
    const previous = originalSetting(native);
    if (!savedSettings().get(savedSettingKey)) {
      await savedSettings().update(savedSettingKey, { hadValue: previous !== undefined, value: previous } satisfies SavedSetting);
    }
    await native.update(nativeSetting, false, configurationTarget());
    try { await config().update('enabled', true, configurationTarget()); }
    catch (error) {
      await native.update(nativeSetting, previous, configurationTarget());
      throw error;
    }
    changed.fire(); reloadNotice();
  };
  const restore = async () => {
    await config().update('enabled', false, configurationTarget());
    const saved = savedSettings().get<SavedSetting>(savedSettingKey);
    const native = vscode.workspace.getConfiguration('chatgpt');
    if (saved && originalSetting(native) === false) {
      await native.update(nativeSetting, saved.hadValue ? saved.value : undefined, configurationTarget());
    }
    await savedSettings().update(savedSettingKey, undefined);
    changed.fire(); reloadNotice();
  };
  const canProvide = () => {
    if (!config().get('enabled', false)) return false;
    if (vscode.workspace.getConfiguration('chatgpt').get(nativeSetting, true)) {
      if (!warnedConflict) {
        warnedConflict = true;
        void vscode.window.showWarningMessage('Use Enable Custom TODOs to switch from the original Codex actions.', 'Enable Custom TODOs')
          .then(action => { if (action) void enable().catch(reportError); });
      }
      return false;
    }
    warnedConflict = false;
    return true;
  };
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(document, token) {
      if (!canProvide() || token.isCancellationRequested) return [];
      return findTodos(document.getText(), config(document.uri).get('trigger', 'TODO')).map(match => {
        const position = document.positionAt(match.offset);
        return new vscode.CodeLens(new vscode.Range(position, position), {
          title: 'Implement with Codex', command: `${namespace}.implement`,
          arguments: [{ uri: document.uri.toString(), version: document.version, offset: match.offset, raw: match.raw } satisfies LensArgument],
        });
      });
    },
  };
  const newClient = async (cwd: string, uri?: vscode.Uri) => {
    const settings = config(uri);
    const executable = await resolveCodex(settings.get('codexPath', ''));
    const home = settings.get<string>('codexHome', '').trim();
    if (home && !path.isAbsolute(home)) throw new Error('Codex Home must be an absolute path.');
    return new CodexRpc({ executable, cwd, home: home || undefined,
      requestHandler: handleServerRequest, log: text => output.append(text),
    });
  };
  const implement = async (argument: LensArgument) => {
    if (!canProvide()) throw new Error('Enable custom TODOs first.');
    if (!argument || typeof argument.uri !== 'string' || !Number.isInteger(argument.offset)) throw new Error('Invalid TODO location.');
    const uri = vscode.Uri.parse(argument.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const settings = config(uri);
    const match = findTodos(document.getText(), settings.get('trigger', 'TODO'))
      .find(item => item.offset === argument.offset && item.raw === argument.raw);
    if (document.version !== argument.version || !match) throw new Error('The comment changed. Click its refreshed TODO action.');
    const todo: TodoContext = { file: uri.scheme === 'file' ? uri.fsPath : uri.toString(true), workspace: workingDirectory(uri), line: document.positionAt(match.offset).line + 1, comment: match.comment };
    const message = settings.get('message', '');
    const targetThreadId = settings.get<string>('targetThreadId', '').trim();
    if (usesNativeAction(message, targetThreadId)) {
      const official = vscode.extensions.getExtension('openai.chatgpt');
      await official?.activate();
      if (!(await vscode.commands.getCommands(true)).includes('chatgpt.implementTodo')) {
        throw new Error('This Codex version does not expose the TODO action. Update Codex or configure a custom message.');
      }
      await vscode.commands.executeCommand('chatgpt.implementTodo', { fileName: todo.file, cwd: todo.workspace, line: todo.line, comment: todo.comment });
      return;
    }
    if (busy) throw new Error('A custom TODO is already running. Wait for it to finish or cancel it.');
    busy = true;
    try {
      if (targetThreadId) {
        await vscode.extensions.getExtension('openai.chatgpt')?.activate();
        const sent = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sending TODO to Codex' }, async () => {
          return sendToOwner({
            threadId: targetThreadId, cwd: todo.workspace, prompt: buildPrompt(todo, message),
            home: settings.get<string>('codexHome', '').trim() || undefined,
            openChat: async () => {
              const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/${encodeURIComponent(targetThreadId)}`);
              if (!await vscode.env.openExternal(uri)) throw new Error('Could not open the selected Codex chat. The TODO was not sent.');
            },
          });
        });
        output.appendLine(`\nThread: ${sent.threadId}\nTurn: ${sent.turnId}\nTODO sent. Follow progress and approvals in the selected Codex chat.`);
        return;
      }
      const client = await newClient(todo.workspace, uri);
      runningClient = client;
      output.show(true);
      output.appendLine(`\n${todo.file}:${todo.line}\n${buildPrompt(todo, message)}\n`);
      try {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Implement with Codex', cancellable: true }, async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          if (token.isCancellationRequested) controller.abort();
          try {
            return await runTodo(client, { cwd: todo.workspace, prompt: buildPrompt(todo, message), targetThreadId, signal: controller.signal,
              onEvent: (method, params) => {
                if (method === 'item/agentMessage/delta') output.append(params.delta ?? '');
                if (method === 'item/started') {
                  const type = params.item?.type ?? 'working';
                  progress.report({ message: type });
                  if (type !== 'agentMessage') output.appendLine(`\n[${type}] ${params.item?.command ?? ''}`);
                }
                if (method === 'item/commandExecution/outputDelta') output.append(params.delta ?? '');
              },
            });
          } finally { cancellation.dispose(); }
        });
        output.appendLine(`\nThread: ${result.threadId}\nStatus: ${result.status}`);
        void vscode.window.showInformationMessage(result.status === 'completed' ? 'Codex finished implementing the TODO.' : `Codex TODO: ${result.status}.`);
      } finally { client.dispose(); runningClient = undefined; }
    } finally { busy = false; }
  };
  const selectThread = async () => {
    let uri = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1 && (!uri || !vscode.workspace.getWorkspaceFolder(uri))) {
      const folder = await vscode.window.showWorkspaceFolderPick();
      if (!folder) return;
      uri = folder.uri;
    }
    const client = await newClient(workingDirectory(uri), uri);
    try {
      const threads = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading Codex threads' }, () => listThreads(client));
      const items = [{ label: 'New thread', description: 'Default', detail: '', id: '' }, ...threads.map(thread => ({
        label: thread.name || thread.preview?.split('\n')[0]?.slice(0, 100) || thread.id,
        description: thread.id, detail: thread.cwd ?? '', id: thread.id,
      }))];
      const choice = await vscode.window.showQuickPick(items, { title: 'TODO target thread', matchOnDescription: true, matchOnDetail: true, placeHolder: 'Choose an idle local thread or create a new thread for each TODO' });
      if (choice) {
        const scope = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : configurationTarget();
        await config(uri).update('targetThreadId', choice.id, scope);
      }
    } finally { client.dispose(); }
  };
  const register = (id: string, fn: (...args: any[]) => Promise<unknown> | unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`${namespace}.${id}`, async (...args) => {
      try { return await fn(...args); } catch (error) { reportError(error); throw error; }
    }));
  };
  register('enable', enable); register('restore', restore); register('implement', implement); register('selectThread', selectThread);
  register('settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-customise.vscode-codex-customise'));
  register('output', () => output.show(true));
  context.subscriptions.push(output, changed, vscode.languages.registerCodeLensProvider('*', provider),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(namespace) || event.affectsConfiguration(`chatgpt.${nativeSetting}`)) changed.fire();
    }));
}

function workingDirectory(uri?: vscode.Uri): string {
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (folder) return folder.uri.fsPath;
  if (uri?.scheme === 'file') return path.dirname(uri.fsPath);
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}
async function resolveCodex(configured: string): Promise<string> {
  if (configured.trim()) {
    if (!path.isAbsolute(configured.trim())) throw new Error('Codex Path must be an absolute executable path.');
    await fs.access(configured.trim(), constants.X_OK);
    return configured.trim();
  }
  const root = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [
    ...(root ? [path.join(root, 'bin', `${platform}-${arch}`, executable)] : []),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(folder => path.join(folder, executable)),
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try the next discovered executable. */ }
  }
  throw new Error('Codex CLI was not found. Set Codex Customise: Codex Path to its executable.');
}

async function handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const summary = method.includes('commandExecution') ? 'Codex requests permission to run a command.' : 'Codex requests permission to change files.';
    const network = params.networkApprovalContext && `${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`;
    const detail = [params.command, params.reason, params.cwd, params.grantRoot, network].filter(Boolean).join('\n\n');
    const canApprove = !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('accept');
    const choice = await vscode.window.showWarningMessage(summary, { modal: true, detail }, ...(canApprove ? ['Approve', 'Reject'] : ['Reject']));
    return { decision: choice === 'Approve' ? 'accept' : 'decline' };
  }
  if (method === 'item/permissions/requestApproval') {
    const choice = await vscode.window.showWarningMessage('Codex requests additional permissions for this turn.',
      { modal: true, detail: `${params.reason ?? ''}\n\n${JSON.stringify(params.permissions, null, 2)}` }, 'Approve', 'Reject');
    const permissions: JsonObject = {};
    if (choice === 'Approve') {
      if (params.permissions?.network) permissions.network = params.permissions.network;
      if (params.permissions?.fileSystem) permissions.fileSystem = params.permissions.fileSystem;
    }
    return { permissions, scope: 'turn' };
  }
  if (method === 'item/tool/requestUserInput') {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of params.questions ?? []) {
      let answer: string | undefined;
      if (question.options?.length && !question.isSecret) {
        const options: vscode.QuickPickItem[] = question.options.map((option: JsonObject) => ({ label: String(option.label), detail: option.description }));
        options.push({ label: 'Write an answer…', detail: '' });
        const selected = await vscode.window.showQuickPick(options, { title: question.header, placeHolder: question.question });
        answer = selected && (selected.label === 'Write an answer…' ? await vscode.window.showInputBox({ prompt: question.question }) : selected.label);
      } else answer = await vscode.window.showInputBox({ prompt: question.question, password: question.isSecret === true });
      answers[question.id] = { answers: answer === undefined ? [] : [answer] };
    }
    return { answers };
  }
  // Unsupported requests receive an explicit protocol error, never an automatic approval.
  throw new Error(`Unsupported Codex request: ${method}. Update VSCode-Codex-Customise before continuing.`);
}

export function deactivate(): void { runningClient?.dispose(); }
