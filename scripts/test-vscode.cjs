const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--package');
const binary = process.env.VSCODE_TEST_BINARY;
const code = process.env.VSCODE_TEST_CLI;
if (!binary) throw new Error('Set VSCODE_TEST_BINARY to the VS Code application executable.');
if (packaged && !code) throw new Error('Set VSCODE_TEST_CLI to the VS Code command-line launcher.');
const runs = path.join(project, '.test-runs');
fs.mkdirSync(runs, { recursive: true });
const root = fs.mkdtempSync(path.join(runs, 'vscode-'));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'codex-home');
const extensions = path.join(root, 'extensions');
const userData = path.join(root, 'user-data');
for (const folder of [workspace, home, extensions, path.join(userData, 'User'), path.join(workspace, '.vscode')]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(root, 'protected.txt'), 'protected fixture');
const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
const fakeExecutable = path.join(root, 'synthetic-codex');
fs.writeFileSync(fakeExecutable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(project, 'test/fixtures/fake-codex.cjs'))} "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({
  'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
}));
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
  'chatgpt.commentCodeLensEnabled': true, 'codexCustomise.codexPath': fakeExecutable,
  'codexCustomise.codexHome': home,
}));
const official = path.join(extensions, 'openai.chatgpt-0.0.0');
fs.mkdirSync(official);
fs.writeFileSync(path.join(official, 'package.json'), JSON.stringify({
  name: 'chatgpt', publisher: 'openai', version: '0.0.0', displayName: 'Synthetic Codex fixture',
  engines: { vscode: '^1.96.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs',
  contributes: { configuration: { title: 'Synthetic Codex fixture', properties: {
    'chatgpt.commentCodeLensEnabled': { type: 'boolean', default: true },
  } } },
}));
fs.copyFileSync(path.join(project, 'test/fixtures/native-extension.cjs'), path.join(official, 'extension.cjs'));
fs.copyFileSync(path.join(project, 'test/fixtures/owner-server.cjs'), path.join(official, 'owner-server.cjs'));
const env = { ...process.env, CODEX_CUSTOMISE_TEST_ROOT: root, CODEX_HOME: home, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
let developmentPath = project;
if (packaged) {
  const vsix = path.join(project, `releases/VSCode-Codex-Customise-${require('../package.json').version}.vsix`);
  const result = spawnSync(code, ['--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { env, encoding: 'utf8', timeout: 60_000 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw result.error ?? new Error('VSIX installation failed.');
  developmentPath = path.join(root, 'test-driver');
  fs.mkdirSync(developmentPath);
  fs.writeFileSync(path.join(developmentPath, 'package.json'), JSON.stringify({ name: 'fixture-driver', publisher: 'local-fixture', version: '0.0.0', engines: { vscode: '^1.96.0' } }));
}
console.log(`Isolated test profile: ${root}`);
const child = spawn(binary, [workspace, '--user-data-dir', userData, '--extensions-dir', extensions,
  '--extensionDevelopmentPath=' + developmentPath, '--extensionTestsPath=' + path.join(project, 'test/vscode.integration.cjs'),
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--disable-updates', '--new-window'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
const processLog = path.join(root, 'vscode.log');
child.stdout.on('data', chunk => fs.appendFileSync(processLog, chunk));
child.stderr.on('data', chunk => fs.appendFileSync(processLog, chunk));
const timer = setTimeout(() => { child.kill('SIGTERM'); console.error('VS Code test timed out.'); }, 90_000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'protected fixture');
  const report = path.join(root, 'results.json');
  if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'));
  if (code !== 0 || !fs.existsSync(report)) {
    console.error(`VS Code exited with code ${code}, signal ${signal}.`);
    if (fs.existsSync(processLog)) console.error(fs.readFileSync(processLog, 'utf8').slice(-6000));
  }
  process.exitCode = code === 0 && fs.existsSync(report) ? 0 : 1;
});
