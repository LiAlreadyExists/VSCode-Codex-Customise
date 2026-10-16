const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexRpc } = require('../dist/rpc');
const { runTodo, listThreads } = require('../dist/runner');

function setup(t, control = {}, approve = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-customise-test-'));
  const cwd = path.join(root, 'project'), home = path.join(root, 'codex-home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'protected.txt'), 'protected fixture');
  fs.writeFileSync(path.join(cwd, 'fixture.ts'), '//TODO: implement\n');
  fs.writeFileSync(path.join(home, 'control.json'), JSON.stringify(control));
  const approvals = [];
  const client = new CodexRpc({ executable: process.execPath, args: [path.join(__dirname, 'fixtures/fake-codex.cjs')], cwd, home,
    env: { CODEX_CUSTOMISE_TEST_ROOT: root }, timeoutMs: 1500,
    requestHandler: async (method, params) => { approvals.push({ method, params }); return { decision: approve ? 'accept' : 'decline' }; },
  });
  t.after(() => {
    client.dispose();
    assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'protected fixture');
  });
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, cwd, home, client, requests, approvals };
}
test('creates a thread and passes exactly the prompt with a bounded write sandbox', async t => {
  const fixture = setup(t, { edit: true });
  const result = await runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'Only this exact text' });
  assert.equal(result.threadId, 'new-fixture');
  const start = fixture.requests().find(x => x.method === 'turn/start');
  assert.equal(start.params.input[0].text, 'Only this exact text');
  assert.deepEqual(start.params.sandboxPolicy.writableRoots, [fixture.cwd]);
  assert.equal(start.params.sandboxPolicy.networkAccess, false);
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(fs.readFileSync(path.join(fixture.cwd, 'fixture.ts'), 'utf8'), 'export const answer = 42;\n');
});
test('resumes the selected thread without creating another', async t => {
  const fixture = setup(t);
  const result = await runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'implement', targetThreadId: 'saved-1' });
  assert.equal(result.threadId, 'saved-1');
  assert.equal(fixture.requests().filter(x => x.method === 'thread/start').length, 0);
  assert.equal(fixture.requests().find(x => x.method === 'turn/start').params.threadId, 'saved-1');
});
test('busy or mismatched destination never receives a turn', async t => {
  for (const control of [{ busy: true }, { wrongThread: true }]) {
    const fixture = setup(t, control);
    await assert.rejects(runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'x', targetThreadId: 'saved-1' }), /running|different thread/);
    assert.equal(fixture.requests().filter(x => x.method === 'turn/start').length, 0);
  }
});
test('handles completion before turn/start response', async t => {
  const fixture = setup(t, { earlyCompletion: true });
  assert.equal((await runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'x' })).status, 'completed');
});
test('approval acceptance and denial control synthetic edits', async t => {
  for (const approve of [true, false]) {
    const fixture = setup(t, { edit: true, approval: true }, approve);
    const result = await runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'x' });
    assert.equal(fixture.approvals.length, 1);
    assert.equal(result.status, approve ? 'completed' : 'interrupted');
    assert.equal(fs.readFileSync(path.join(fixture.cwd, 'fixture.ts'), 'utf8').includes('42'), approve);
  }
});
test('cancels the active turn by its exact ID', async t => {
  const fixture = setup(t, { hold: true });
  const controller = new AbortController();
  const run = runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'x', signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  assert.equal((await run).status, 'interrupted');
  assert.deepEqual(fixture.requests().find(x => x.method === 'turn/interrupt').params, { threadId: 'new-fixture', turnId: 'turn-fixture' });
});
test('lists all pages and reports unsupported methods without silent fallback', async t => {
  const fixture = setup(t, { paginate: true });
  assert.deepEqual((await listThreads(fixture.client)).map(x => x.id), ['saved-1', 'saved-2']);
  const bad = setup(t, { unsupported: 'thread/list' });
  await assert.rejects(listThreads(bad.client), /Method not found/);
});
test('disconnects and timeouts reject without resending the message', async t => {
  for (const control of [{ disconnect: true }, { timeout: 'turn/start' }]) {
    const fixture = setup(t, control);
    await assert.rejects(runTodo(fixture.client, { cwd: fixture.cwd, prompt: 'x' }), /disconnected|timed out/);
    assert.equal(fixture.requests().filter(x => x.method === 'turn/start').length, 1);
  }
});
