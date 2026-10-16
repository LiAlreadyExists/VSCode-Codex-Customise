#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.CODEX_CUSTOMISE_TEST_ROOT;
if (!root || !process.env.CODEX_HOME) throw new Error('Synthetic test directories are required.');
const realRoot = fs.realpathSync(root);
const cwd = fs.realpathSync(process.cwd());
const home = fs.realpathSync(process.env.CODEX_HOME);
for (const location of [cwd, home]) {
  if (!location.startsWith(realRoot + path.sep)) throw new Error('Refusing to use files outside the test root.');
}
const controlPath = path.join(home, 'control.json');
const control = fs.existsSync(controlPath) ? JSON.parse(fs.readFileSync(controlPath, 'utf8')) : {};
const log = path.join(home, 'requests.jsonl');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
let active;
let completion;
const finish = (status = 'completed') => {
  if (!active) return;
  send({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status } } });
};
const implement = () => {
  if (control.edit) fs.writeFileSync(path.join(cwd, 'fixture.ts'), 'export const answer = 42;\n');
  send({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: active.turnId, delta: 'Implemented fixture.' } });
  finish();
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(message) + '\n');
  const { id, method, params = {} } = message;
  if (!method && id === 'approval') { message.result?.decision === 'accept' ? implement() : finish('interrupted'); return; }
  if (control.unsupported === method) { send({ id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (control.timeout === method) return;
  if (method === 'initialize') reply(id, { userAgent: 'synthetic-codex/1.0' });
  else if (method === 'thread/list') {
    const data = params.cursor ? [{ id: 'saved-2', name: 'Second fixture', cwd }] : [{ id: 'saved-1', name: 'First fixture', cwd }];
    reply(id, { data, nextCursor: params.cursor || !control.paginate ? null : 'page-2' });
  } else if (method === 'thread/start') reply(id, { thread: { id: 'new-fixture', cwd, status: { type: 'idle' } } });
  else if (method === 'thread/read' || method === 'thread/resume') {
    reply(id, { thread: { id: control.wrongThread && method === 'thread/resume' ? 'wrong-thread' : params.threadId, cwd, status: { type: control.busy ? 'active' : 'idle' } } });
  } else if (method === 'turn/start') {
    active = { threadId: params.threadId, turnId: 'turn-fixture' };
    if (control.earlyCompletion) finish();
    reply(id, { turn: { id: active.turnId, status: 'inProgress' } });
    if (control.disconnect) { process.exit(2); return; }
    if (control.approval) send({ id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: active.threadId, turnId: active.turnId, itemId: 'change-fixture', reason: 'Change synthetic fixture' } });
    else if (!control.hold && !control.earlyCompletion) completion = setTimeout(implement, 15);
  } else if (method === 'turn/interrupt') { clearTimeout(completion); reply(id, {}); finish('interrupted'); }
}).on('close', () => process.exit(0));
