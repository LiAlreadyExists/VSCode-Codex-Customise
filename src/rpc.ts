import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export type JsonObject = Record<string, any>;
export interface RpcOptions {
  executable: string; args?: string[]; cwd: string; home?: string; env?: NodeJS.ProcessEnv;
  timeoutMs?: number; requestHandler: (method: string, params: JsonObject) => Promise<unknown>;
  log?: (message: string) => void;
}
export class RpcError extends Error {
  constructor(message: string, public readonly code?: number) { super(message); }
}

/** One stdio connection. Mutating calls are never retried after timeout or disconnect. */
export class CodexRpc extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private disposed = false;
  private ready?: Promise<void>;
  constructor(private readonly options: RpcOptions) { super(); }

  start(): Promise<void> {
    return this.ready ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Codex connection is closed.');
    const env = { ...process.env, ...this.options.env };
    if (this.options.home) env.CODEX_HOME = this.options.home;
    const child = spawn(this.options.executable, this.options.args ?? ['app-server'], {
      cwd: this.options.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let value: JsonObject;
      try { value = JSON.parse(line); } catch { this.fail(new Error('Codex returned invalid JSON.')); child.kill(); return; }
      if (value && typeof value === 'object') void this.receive(value);
    });
    child.stderr.on('data', (chunk: Buffer) => this.options.log?.(chunk.toString().slice(0, 4000)));
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(new Error(`Cannot start Codex: ${error.message}`)));
    child.on('exit', (code, signal) => {
      lines.close();
      this.fail(new Error(`Codex disconnected (${signal ?? code ?? 'closed'}). Check thread status before retrying.`));
    });
    await this.request('initialize', {
      clientInfo: { name: 'vscode_codex_customise', title: 'VSCode-Codex-Customise', version: '0.1.4' },
      capabilities: { experimentalApi: false },
    });
    this.write({ method: 'initialized', params: {} });
  }
  request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Delivery is uncertain; check the thread before retrying.`));
      }, this.options.timeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  private write(value: unknown): void {
    if (!this.process?.stdin.writable) throw new Error('Codex connection is not writable.');
    this.process.stdin.write(JSON.stringify(value) + '\n');
  }
  private async receive(value: JsonObject): Promise<void> {
    if (typeof value.method === 'string') {
      if (value.id !== undefined) {
        try {
          const result = await this.options.requestHandler(value.method, value.params ?? {});
          if (!this.disposed) this.write({ id: value.id, result });
        } catch (error) {
          if (!this.disposed) this.write({ id: value.id, error: { code: -32601, message: String(error) } });
        }
      } else this.emit('notification', value.method, value.params ?? {});
      return;
    }
    const entry = this.pending.get(value.id);
    if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(value.id);
    if (value.error) entry.reject(new RpcError(value.error.message ?? 'Codex request failed.', value.error.code));
    else entry.resolve(value.result);
  }
  private fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }
  dispose(): void {
    this.fail(new Error('Codex connection closed.'));
    this.process?.stdin.end();
    const child = this.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill(), 1500); timer.unref();
    }
  }
}
