import { connect, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { JsonObject } from './rpc';

// Codex's local owner/follower protocol. Keep the versioned adapter separate
// from the public app-server client; never take ownership or modify lock files.
const versions: Record<string, number> = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
  'thread-stream-following-changed': 1,
  'thread-stream-state-changed': 11,
};
const maximumFrame = 32 * 1024 * 1024;

export class OwnerError extends Error {}
class OwnerConnectionError extends OwnerError {}

export class CodexOwner extends EventEmitter {
  private socket?: Socket;
  private clientId = 'initializing-client';
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private pending = new Map<string, {
    method: string; resolve: (value: JsonObject) => void;
    reject: (error: Error) => void; timer: NodeJS.Timeout;
  }>();

  async open(endpoint: string, timeoutMs = 5000): Promise<void> {
    this.socket = connect(endpoint);
    this.socket.on('data', data => this.receive(data));
    this.socket.on('error', error => this.fail(
      ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes((error as NodeJS.ErrnoException).code ?? '')
        ? new OwnerConnectionError(error.message, { cause: error }) : error));
    this.socket.on('close', () => this.fail(new OwnerConnectionError('Codex chat connection closed.')));
    const result = await this.request('initialize', { clientType: 'vscode-codex-customise' }, undefined, timeoutMs);
    if (typeof result.result?.clientId !== 'string') throw new OwnerError('Unsupported Codex chat connection response.');
    this.clientId = result.result.clientId;
  }

  async find(threadId: string, timeoutMs = 5000): Promise<string | undefined> {
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, undefined, timeoutMs);
    if (response.resultType === 'error' && response.error === 'no-client-found') return undefined;
    this.assertSuccess(response);
    if (typeof response.handledByClientId !== 'string') throw new OwnerError('Codex returned no chat owner.');
    return response.handledByClientId;
  }

  async snapshot(threadId: string, ownerId: string, timeoutMs = 10000): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('broadcast', receive);
        this.off('closed', stopped);
      };
      const stopped = (error: Error) => { cleanup(); reject(error); };
      const receive = (message: JsonObject) => {
        const params = message.params;
        if (message.sourceClientId !== ownerId || message.method !== 'thread-stream-state-changed'
          || params?.hostId !== 'local' || params.conversationId !== threadId) return;
        if (message.version !== versions['thread-stream-state-changed']) {
          stopped(new OwnerError('This Codex version uses an unsupported chat protocol. Update VSCode-Codex-Customise.'));
          return;
        }
        if (params.change?.type !== 'snapshot') return;
        const state = params.change.conversationState;
        if (!state || state.id !== threadId) {
          stopped(new OwnerError('Codex returned a different chat. The TODO was not sent.'));
          return;
        }
        cleanup(); resolve(state);
      };
      const timer = setTimeout(() => stopped(new OwnerConnectionError('Could not read the open Codex chat.')), timeoutMs);
      this.on('broadcast', receive);
      this.on('closed', stopped);
      try { this.follow(threadId, ownerId, true); } catch (error) { stopped(error as Error); }
    });
  }

  async startTurn(threadId: string, ownerId: string, cwd: string, prompt: string): Promise<JsonObject> {
    let response: JsonObject;
    try {
      response = await this.request('thread-follower-start-turn', {
        conversationId: threadId,
        turnStart: {
          request: {
            threadId, clientUserMessageId: randomUUID(), cwd,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
            approvalPolicy: 'on-request',
            sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          },
          context: { inheritThreadSettings: true },
        },
      }, ownerId, 45000);
      this.assertSuccess(response);
      const result = response.result?.result;
      if (typeof result?.turn?.id !== 'string') throw new OwnerError('Codex did not confirm the submitted turn.');
      return result;
    } catch (error) {
      // A timeout/error after dispatch can still mean the owner accepted it.
      // In particular, do not fall back to another process and send it twice.
      throw new OwnerError(`${error instanceof Error ? error.message : error} Check the selected chat before retrying; the TODO was not resent.`);
    }
  }

  follow(threadId: string, ownerId: string, following: boolean): void {
    this.write({
      type: 'broadcast', method: 'thread-stream-following-changed',
      sourceClientId: this.clientId, version: versions['thread-stream-following-changed'],
      targetClientIds: [ownerId], params: { hostId: 'local', conversationId: threadId, following },
    });
  }

  private request(method: string, params: JsonObject, targetClientId?: string, timeoutMs = 12000): Promise<JsonObject> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new OwnerConnectionError(`Codex ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer });
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId,
          method, version: versions[method], params, targetClientId, timeoutMs });
      } catch (error) {
        clearTimeout(timer); this.pending.delete(requestId); reject(error);
      }
    });
  }

  private assertSuccess(response: JsonObject): void {
    if (response.resultType === 'error' && ['server-closed', 'client-disconnected', 'target-client-disconnected', 'request-timeout'].includes(response.error)) {
      throw new OwnerConnectionError(`Codex chat: ${response.error}`);
    }
    if (response.resultType !== 'success') throw new OwnerError(`Codex chat: ${response.error ?? 'unsupported response'}`);
  }

  private write(message: JsonObject): void {
    if (this.closed || !this.socket?.writable) throw new OwnerConnectionError('Codex chat connection is unavailable.');
    const data = Buffer.from(JSON.stringify(message), 'utf8');
    if (data.length > maximumFrame) throw new OwnerError('Codex chat message is too large.');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    this.socket.write(Buffer.concat([header, data]));
  }

  private receive(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > maximumFrame) throw new OwnerError('Invalid Codex chat message size.');
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(length + 4);
        if (!message || typeof message !== 'object') throw new OwnerError('Invalid Codex chat message.');
        if (message.type === 'client-discovery-request') {
          this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'response') {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId); clearTimeout(pending.timer);
          if (message.resultType === 'success' && message.method !== pending.method) {
            pending.reject(new OwnerError('Codex chat response method mismatch.'));
          } else pending.resolve(message);
        } else if (message.type === 'broadcast') {
          if (!message.targetClientIds || message.targetClientIds.includes(this.clientId)) this.emit('broadcast', message);
        }
      }
    } catch (error) { this.fail(error as Error); }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
    this.socket?.destroy();
    this.buffer = Buffer.alloc(0);
  }

  dispose(): void { this.fail(new OwnerError('Codex chat connection closed.')); }
}

export async function ownerEndpoints(home?: string): Promise<string[]> {
  if (process.platform === 'win32') return ['\\\\.\\pipe\\codex-ipc'];
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const root = home || process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const candidates = [path.join(root, 'ipc', 'ipc.sock')];
  if (!home) candidates.push(path.join(tmpdir(), 'codex-ipc', uid ? `ipc-${uid}.sock` : 'ipc.sock'));
  const endpoints: string[] = [];
  for (const candidate of candidates) {
    try {
      const [socket, directory] = await Promise.all([lstat(candidate), lstat(path.dirname(candidate))]);
      if (socket.isSocket() && socket.uid === uid && directory.isDirectory() && directory.uid === uid && !(directory.mode & 0o022)) endpoints.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return endpoints;
}

interface SendOptions {
  threadId: string;
  cwd: string;
  prompt: string;
  home?: string;
  waitForOwnerMs?: number;
  openChat?: () => Promise<void>;
}
interface OwnerConnection { client: CodexOwner; ownerId: string }
type Lookup = { connection: OwnerConnection } | { unavailable?: OwnerConnectionError };

export async function sendToOwner(options: SendOptions): Promise<{ threadId: string; turnId: string }> {
  const deadline = Date.now() + (options.waitForOwnerMs ?? 20000);
  let opened = false;
  let unavailable: OwnerConnectionError | undefined;
  const openOnce = async () => {
    if (opened) return;
    opened = true;
    await options.openChat?.();
  };
  do {
    const found = await findOwner(options, deadline);
    if ('connection' in found) {
      const { client, ownerId } = found.connection;
      try {
        await openOnce();
        // Delivery is outside the lookup retry path. An uncertain response
        // must never result in a duplicate turn or a competing writer.
        const result = await client.startTurn(options.threadId, ownerId, options.cwd, options.prompt);
        return { threadId: options.threadId, turnId: result.turn.id };
      } finally { closeOwner(client, options.threadId, ownerId); }
    }
    unavailable = found.unavailable;
    // A missing owner can be loaded by the native UI. An unresponsive owner
    // cannot: opening the UI then could try to claim a chat still held elsewhere.
    if (!unavailable) await openOnce();
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (unavailable) throw new OwnerError('Codex’s connection to the selected chat is not responding. The TODO was not sent.', { cause: unavailable });
  throw new OwnerError('The selected Codex chat did not become ready. Open it in Codex and try again. The TODO was not sent.');
}

async function findOwner(options: SendOptions, deadline: number): Promise<Lookup> {
  let unavailable: OwnerConnectionError | undefined;
  for (const endpoint of await ownerEndpoints(options.home)) {
    if (Date.now() >= deadline) break;
    const client = new CodexOwner();
    let ownerId: string | undefined;
    let ready = false;
    try {
      await client.open(endpoint, Math.max(1, Math.min(5000, deadline - Date.now())));
      ownerId = await client.find(options.threadId, Math.max(1, Math.min(5000, deadline - Date.now())));
      if (!ownerId) continue;
      const state = await client.snapshot(options.threadId, ownerId, Math.max(1, Math.min(10000, deadline - Date.now())));
      const turns = [...(Array.isArray(state.turns) ? state.turns : []), ...Object.values(state.turnHistory?.history?.entitiesByKey ?? {})] as JsonObject[];
      if (state.threadRuntimeStatus?.type === 'active' || turns.some(turn => turn.status === 'inProgress') || state.unconfirmedTurnSubmissions?.length) {
        throw new OwnerError('The selected chat is running. Wait for it to finish before sending this TODO.');
      }
      ready = true;
      return { connection: { client, ownerId } };
    } catch (error) {
      if (!(error instanceof OwnerConnectionError)) throw error;
      unavailable = error;
    } finally {
      if (!ready) closeOwner(client, options.threadId, ownerId);
    }
  }
  return { unavailable };
}

function closeOwner(client: CodexOwner, threadId: string, ownerId?: string): void {
  if (ownerId) { try { client.follow(threadId, ownerId, false); } catch { /* Socket may have closed. */ } }
  client.dispose();
}
