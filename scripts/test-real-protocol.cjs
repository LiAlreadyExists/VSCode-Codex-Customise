const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { CodexRpc } = require('../dist/rpc');
const { runTodo, listThreads } = require('../dist/runner');

async function main() {
  const executable = process.env.CODEX_TEST_EXECUTABLE;
  if (!executable) throw new Error('Set CODEX_TEST_EXECUTABLE to a Codex CLI binary.');
  fs.mkdirSync(path.join(__dirname, '../.test-runs'), { recursive: true });
  const root = fs.mkdtempSync(path.join(__dirname, '../.test-runs/protocol-'));
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'codex-home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.writeFileSync(path.join(cwd, 'fixture.ts'), '//TODO: fixture\n');
  fs.writeFileSync(path.join(root, 'protected.txt'), 'protected fixture');
  const modelRequests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (!request.url?.endsWith('/responses')) { response.writeHead(404); response.end('{}'); return; }
      modelRequests.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Protocol fixture complete.', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Protocol fixture complete.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const createClient = () => new CodexRpc({ executable, cwd, home, timeoutMs: 20_000,
    requestHandler: async method => { throw new Error(`Unexpected request in read-only protocol fixture: ${method}`); },
    log: text => fs.appendFileSync(path.join(root, 'server.log'), text),
  });
  let client = createClient();
  const guard = setTimeout(() => client.dispose(), 45_000);
  try {
    const first = await runTodo(client, { cwd, prompt: 'Protocol fixture first message. Return the test response; do not use tools.' });
    assert.equal(first.status, 'completed');
    client.dispose();
    client = createClient();
    const second = await runTodo(client, { cwd, targetThreadId: first.threadId, prompt: 'Protocol fixture second message.' });
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.status, 'completed');
    const listed = await listThreads(client);
    assert.ok(listed.some(thread => thread.id === first.threadId), 'Created thread can be selected through thread/list');
    assert.equal(modelRequests.length, 2);
    assert.match(JSON.stringify(modelRequests[0].input), /Protocol fixture first message/);
    assert.match(JSON.stringify(modelRequests[1].input), /Protocol fixture second message/);
    assert.equal(fs.readFileSync(path.join(cwd, 'fixture.ts'), 'utf8'), '//TODO: fixture\n');
    assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'protected fixture');
    const result = { actualCodexBinary: executable, isolatedDirectory: root, passed: ['initialize', 'thread/start', 'turn/start', 'thread/read', 'thread/resume after process restart', 'thread/list', 'streamed completion'], model: 'local synthetic Responses server', originalUserFilesUsed: false };
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { clearTimeout(guard); client.dispose(); server.closeAllConnections(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
