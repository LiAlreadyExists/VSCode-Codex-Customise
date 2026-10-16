const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sendToOwner, ownerEndpoints } = require('../dist/owner');
const { startOwnerServer } = require('./fixtures/owner-server.cjs');

async function setup(t, control) {
  const runs = path.resolve(__dirname, '../.test-runs');
  fs.mkdirSync(runs, { recursive: true });
  const home = fs.mkdtempSync(path.join(runs, 'owner-'));
  const server = await startOwnerServer(home, control);
  t.after(() => server.close());
  return { ...server, home, send: (options = {}) => sendToOwner({ threadId: 'owned-fixture', home, cwd: home, prompt: 'Implement {literal} in test.tex', waitForOwnerMs: 1000, ...options }) };
}

test('routes the exact prompt once to the existing owner without resuming or creating a thread', async t => {
  const fixture = await setup(t, { splitFrames: true });
  assert.deepEqual(await fixture.send(), { threadId: 'owned-fixture', turnId: 'owner-turn' });
  const turns = fixture.messages.filter(x => x.method === 'thread-follower-start-turn');
  assert.equal(turns.length, 1);
  const message = turns[0], request = message.params.turnStart.request;
  assert.equal(message.version, 2);
  assert.equal(message.targetClientId, 'fixture-owner');
  assert.equal(message.params.conversationId, 'owned-fixture');
  assert.equal(request.threadId, 'owned-fixture');
  assert.equal(request.input[0].text, 'Implement {literal} in test.tex');
  assert.deepEqual(request.sandboxPolicy.writableRoots, [fixture.home]);
  assert.equal(request.approvalPolicy, 'on-request');
  assert.equal(request.model, undefined);
  assert.equal(message.params.turnStart.context.inheritThreadSettings, true);
  assert.equal(fixture.messages.some(x => /^(thread\/resume|thread\/start|turn\/start)$/.test(x.method)), false);
});

test('missing ownership fails without allowing a second process to resume the thread', async t => {
  const fixture = await setup(t, { noOwner: true });
  await assert.rejects(fixture.send(), /did not become ready.*TODO was not sent/);
  assert.equal(fixture.messages.some(x => x.method === 'thread-follower-start-turn'), false);
});

test('waits for a loading chat and sends once after its owner becomes discoverable', async t => {
  const fixture = await setup(t, { missingDiscoveries: 2 });
  assert.deepEqual(await fixture.send(), { threadId: 'owned-fixture', turnId: 'owner-turn' });
  assert.equal(fixture.messages.filter(x => x.method === 'thread-owner-discovery').length, 3);
  assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
});

test('waits for Codex IPC startup before owner discovery', async t => {
  const runs = path.resolve(__dirname, '../.test-runs');
  fs.mkdirSync(runs, { recursive: true });
  const home = fs.mkdtempSync(path.join(runs, 'owner-startup-'));
  const sending = sendToOwner({ threadId: 'owned-fixture', home, cwd: home, prompt: 'test', waitForOwnerMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const server = await startOwnerServer(home);
  t.after(() => server.close());
  assert.deepEqual(await sending, { threadId: 'owned-fixture', turnId: 'owner-turn' });
  assert.equal(server.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
});

test('busy, mismatched and incompatible chats reject before sending a TODO', async t => {
  for (const control of [{ busy: true }, { pendingTurn: true }, { wrongThread: true }, { version: 999 }]) {
    const fixture = await setup(t, control);
    await assert.rejects(fixture.send(), /running|different chat|unsupported chat protocol/);
    assert.equal(fixture.messages.some(x => x.method === 'thread-follower-start-turn'), false);
  }
});

test('uncertain or rejected owner delivery is never retried or silently redirected', async t => {
  for (const control of [{ disconnect: true }, { error: 'request-timeout' }]) {
    const fixture = await setup(t, control);
    await assert.rejects(fixture.send(), /Check the selected chat before retrying/);
    assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
  }
});

test('an explicit Codex home does not use an unrelated account socket', async () => {
  const home = path.resolve(__dirname, '../.test-runs/nonexistent-owner-home');
  assert.deepEqual(await ownerEndpoints(home), []);
});

test('checks the existing owner before opening the native chat', async t => {
  const fixture = await setup(t);
  let opens = 0;
  await fixture.send({ openChat: async () => {
    opens++;
    assert.ok(fixture.messages.some(x => x.method === 'thread-stream-following-changed'));
    assert.equal(fixture.messages.some(x => x.method === 'thread-follower-start-turn'), false);
  } });
  assert.equal(opens, 1);
  assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
});

test('opens an ownerless chat only once and waits for its native owner', async t => {
  const control = { noOwner: true };
  const fixture = await setup(t, control);
  let opens = 0;
  await fixture.send({ openChat: async () => {
    opens++;
    assert.ok(fixture.messages.some(x => x.method === 'thread-owner-discovery'));
    control.noOwner = false;
  } });
  assert.equal(opens, 1);
  assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
});

test('reconnects after a dropped connection during initialization, discovery or snapshot', async t => {
  for (const method of ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed']) {
    const fixture = await setup(t, { disconnectBefore: method });
    assert.deepEqual(await fixture.send(), { threadId: 'owned-fixture', turnId: 'owner-turn' });
    assert.equal(fixture.messages.filter(x => x.method === 'initialize').length, 2);
    assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
  }
});

test('retries a discovery timeout without opening a competing chat or repeating delivery', async t => {
  const fixture = await setup(t, { stalledDiscoveries: 1 });
  let opens = 0;
  await fixture.send({ waitForOwnerMs: 8000, openChat: async () => {
    opens++;
    assert.ok(fixture.messages.some(x => x.method === 'thread-stream-following-changed'));
  } });
  assert.equal(fixture.messages.filter(x => x.method === 'initialize').length, 2);
  assert.equal(opens, 1);
  assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
});

test('an unreachable owner never opens a competing native chat or submits a turn', async t => {
  for (const control of [{ suppressDiscovery: true }, { suppressSnapshot: true }]) {
    const fixture = await setup(t, control);
    let opens = 0;
    await assert.rejects(fixture.send({ waitForOwnerMs: 100, openChat: async () => { opens++; } }), /not responding.*TODO was not sent/);
    assert.equal(opens, 0);
    assert.equal(fixture.messages.some(x => x.method === 'thread-follower-start-turn'), false);
  }
});

test('a second message discovers the new owner after a router restart', async t => {
  const fixture = await setup(t);
  await fixture.send();
  await fixture.close();
  const replacement = await startOwnerServer(fixture.home, { ownerId: 'reconnected-owner' });
  t.after(() => replacement.close());
  await fixture.send();
  const turns = replacement.messages.filter(x => x.method === 'thread-follower-start-turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].targetClientId, 'reconnected-owner');
  assert.equal(fixture.messages.filter(x => x.method === 'thread-follower-start-turn').length, 1);
});
