import { CodexRpc, JsonObject } from './rpc';

export interface ThreadSummary { id: string; name?: string | null; preview?: string; cwd?: string; status?: { type: string } }
export interface RunOptions {
  cwd: string; prompt: string; targetThreadId?: string; signal?: AbortSignal;
  onEvent?: (method: string, params: JsonObject) => void;
}
export interface RunResult { threadId: string; turnId: string; status: string }

export async function listThreads(client: CodexRpc): Promise<ThreadSummary[]> {
  await client.start();
  const threads: ThreadSummary[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const result: { data: ThreadSummary[]; nextCursor?: string | null } = await client.request('thread/list', {
      limit: 100, cursor, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
    });
    if (!Array.isArray(result.data)) throw new Error('Unsupported Codex thread/list response.');
    threads.push(...result.data);
    cursor = result.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error('Codex repeated a thread-list cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return threads;
}

export async function runTodo(client: CodexRpc, options: RunOptions): Promise<RunResult> {
  await client.start();
  options.signal?.throwIfAborted();
  let thread: ThreadSummary;
  if (options.targetThreadId) {
    const existing = await client.request('thread/read', { threadId: options.targetThreadId, includeTurns: false });
    if (existing.thread?.status?.type === 'active') throw new Error('The selected thread is running. Wait for it to finish before sending this TODO.');
    const result = await client.request('thread/resume', { threadId: options.targetThreadId });
    thread = result.thread;
    if (!thread || thread.id !== options.targetThreadId) throw new Error('Codex resumed a different thread. The TODO was not sent.');
    if (thread.status?.type === 'active') throw new Error('The selected thread started running. The TODO was not sent.');
  } else {
    const result = await client.request('thread/start', { cwd: options.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    thread = result.thread;
  }
  if (!thread?.id) throw new Error('Codex returned no thread ID.');
  options.signal?.throwIfAborted();
  let turnId: string | undefined;
  const early: JsonObject[] = [];
  let resolveDone!: (result: RunResult) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<RunResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Attach a rejection handler before awaiting turn/start; the process can exit before its reply.
  void done.catch(() => {});
  const finish = (params: JsonObject) => {
    if (!turnId) { early.push(params); return; }
    if (params.turn?.id !== turnId) return;
    const status = params.turn.status;
    if (status === 'failed') rejectDone(new Error(params.turn.error?.message ?? 'Codex could not complete this TODO.'));
    else resolveDone({ threadId: thread.id, turnId, status });
  };
  const notification = (method: string, params: JsonObject) => {
    if (params.threadId !== thread.id) return;
    if (turnId && params.turnId && params.turnId !== turnId) return;
    options.onEvent?.(method, params);
    if (method === 'turn/completed') finish(params);
  };
  const closed = (error: Error) => rejectDone(error);
  const abort = () => {
    if (turnId) void client.request('turn/interrupt', { threadId: thread.id, turnId }).catch(rejectDone);
  };
  client.on('notification', notification);
  client.on('closed', closed);
  options.signal?.addEventListener('abort', abort);
  try {
    const result = await client.request('turn/start', {
      threadId: thread.id, input: [{ type: 'text', text: options.prompt, text_elements: [] }],
      cwd: options.cwd, approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [options.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    if (!result.turn?.id) throw new Error('Codex returned no turn ID. Check the thread before retrying.');
    turnId = result.turn.id;
    if (options.signal?.aborted) abort();
    for (const event of early) finish(event);
    if (['completed', 'failed', 'interrupted'].includes(result.turn.status)) finish({ turn: result.turn });
    return await done;
  } finally {
    client.off('notification', notification); client.off('closed', closed);
    options.signal?.removeEventListener('abort', abort);
  }
}
