const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { startOwnerServer } = require('./owner-server.cjs');
exports.activate = async context => {
  if (!process.env.CODEX_CUSTOMISE_TEST_ROOT) throw new Error('Test profile required.');
  const control = {
    noOwner: true,
    onTurn: message => fs.writeFileSync(path.join(process.env.CODEX_CUSTOMISE_TEST_ROOT, 'owner-call.json'), JSON.stringify(message)),
  };
  const owner = await startOwnerServer(process.env.CODEX_HOME, control);
  context.subscriptions.push({ dispose: () => owner.close() });
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri(uri) {
    assertRoute(uri);
    fs.writeFileSync(path.join(process.env.CODEX_CUSTOMISE_TEST_ROOT, 'native-route.json'), JSON.stringify({ path: uri.path }));
    const threadId = decodeURIComponent(uri.path.slice('/local/'.length));
    if (control.noOwner || control.threadId !== threadId) {
      control.noOwner = true;
      control.threadId = threadId;
      setTimeout(() => { control.noOwner = false; }, 400);
    }
  } }));
  context.subscriptions.push(vscode.commands.registerCommand('chatgpt.implementTodo', argument => {
    fs.writeFileSync(path.join(process.env.CODEX_CUSTOMISE_TEST_ROOT, 'native-call.json'), JSON.stringify(argument));
  }), vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
    provideCodeLenses(document) {
      if (!vscode.workspace.getConfiguration('chatgpt').get('commentCodeLensEnabled', true)) return [];
      const index = document.getText().indexOf('//TODO');
      return index < 0 ? [] : [new vscode.CodeLens(new vscode.Range(document.positionAt(index), document.positionAt(index)), { title: 'Implement with Codex', command: 'chatgpt.implementTodo', arguments: [{}] })];
    },
  }));
};

function assertRoute(uri) {
  if (uri.authority !== 'openai.chatgpt' || !uri.path.startsWith('/local/')) throw new Error('Unexpected Codex URI');
}
