import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type { LarkChannelEnvContext } from '../lark-channel-env';
import { buildLarkChannelEnv } from '../lark-channel-env';

/**
 * JSON-RPC client for `zcode app-server` (the "ZCode Protocol" stdio server —
 * the same engine the desktop app talks to). One client multiplexes many
 * sessions over a single long-lived process.
 *
 * Wire format, reverse-engineered against zcode 0.16.5 (no public docs):
 *  - client→server: `{"id":number,"method":string,"params":object}`
 *  - server→client response: `{"id":number,"result":...}` | `{"id":number,"error":...}`
 *  - server→client notification: `{"method":"session/event","params":{sessionId,type,payload,...}}`
 *  - server→client REQUEST (must be answered or calls like session/create time
 *    out): `session/requestRuntimePreferences` → reply
 *    `{nativeSearchEnhancementsEnabled:false}`; `interaction/*` requests → `{}`.
 */
type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown> & { sessionId?: string };
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AppServerSessionEvent {
  sessionId?: string;
  turnId?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

type SessionEventListener = (event: AppServerSessionEvent) => void;

const REQUEST_TIMEOUT_MS = 120_000;

export class ZcodeAppServerClient {
  private readonly command: string;
  private readonly preArgs: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private child: AppServerChild | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout }>();
  private readonly listeners = new Map<string, Set<SessionEventListener>>();
  private startPromise: Promise<AppServerChild> | undefined;
  private crashed: Error | undefined;
  private crashWaiters: Array<() => void> = [];
  private heartbeatTimer: NodeJS.Timeout | undefined;
  /** Counts every message received from the child (responses + events). */
  private lastInboundAt = Date.now();

  /** Resolves the next time the app-server process dies (for run loops racing on it). */
  get nextCrash(): Promise<void> {
    return new Promise<void>((resolve) => this.crashWaiters.push(resolve));
  }

  constructor(input: { command: string; preArgs: readonly string[]; larkChannel?: LarkChannelEnvContext; env?: NodeJS.ProcessEnv }) {
    this.command = input.command;
    this.preArgs = [...input.preArgs];
    this.env = input.env ?? mergeProcessEnv(process.env, buildLarkChannelEnv(input.larkChannel));
  }

  /** The live child process, spawning (or restarting) it on first use. */
  ensureStarted(): Promise<AppServerChild> {
    if (this.crashed && !this.child) {
      // After a crash, allow a fresh start attempt on the next run.
      this.crashed = undefined;
    }
    this.startPromise ??= this.start().catch((err: Error) => {
      this.startPromise = undefined;
      throw err;
    });
    this.ensureHeartbeat();
    return this.startPromise;
  }

  /**
   * Heartbeat: every 30s, probe the engine with a lightweight ping. If the
   * process is alive but silent for over 90s (stdio pipe jammed — the
   * process runs but events/responses never arrive), treat it as a crash
   * and tear it down so the next run reconnects fresh.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const silentMs = Date.now() - this.lastInboundAt;
      if (silentMs < 90_000) {
        // Still healthy or recently active — send a probe ping.
        this.request('ping', {}).catch(() => undefined);
        return;
      }
      // Over 90s with zero inbound traffic while a run may be waiting —
      // the pipe is almost certainly jammed. Force-crash to recover.
      log.warn('agent', 'app-server-heartbeat-dead', {
        pid: child.pid ?? null,
        silentMs,
        action: 'force-kill for reconnection',
      });
      this.handleCrash(new Error(`app-server unresponsive for ${Math.round(silentMs / 1000)}s (heartbeat)`));
      child.kill('SIGKILL');
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private async start(): Promise<AppServerChild> {
    const child = spawnProcess(this.command, [...this.preArgs, 'app-server'], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as AppServerChild;
    if (!child.pid) {
      const err = new Error('failed to spawn zcode app-server');
      child.once('error', (e) => {
        this.handleCrash(e);
      });
      throw err;
    }
    this.child = child;
    child.stdin.on('error', (err) => log.warn('agent', 'app-server-stdin-error', { message: err.message }));
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) log.warn('agent', 'app-server-stderr', { line: line.slice(0, 300) });
    });
    child.once('exit', (code, signal) => {
      log.info('agent', 'app-server-exit', { pid: child.pid ?? null, code, signal });
      this.handleCrash(new Error(`zcode app-server exited (code=${code}, signal=${signal})`));
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });
    log.info('agent', 'app-server-start', { pid: child.pid ?? null });
    return child;
  }

  private handleMessage(msg: JsonRpcMessage): void {
    this.lastInboundAt = Date.now();
    // Server→client request: must reply or the waiting call times out.
    if (msg.method && msg.id !== undefined && (msg.result === undefined && msg.error === undefined)) {
      this.replyToServer(String(msg.id), msg.method);
      return;
    }
    if (msg.id !== undefined && typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`${entry.method} failed: ${msg.error.message ?? 'unknown error'}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'session/event' && msg.params) {
      const sessionId = msg.params.sessionId;
      if (!sessionId) return;
      const set = this.listeners.get(sessionId);
      if (!set) return;
      for (const listener of set) {
        try {
          listener(msg.params as AppServerSessionEvent);
        } catch (err) {
          log.warn('agent', 'app-server-listener-error', { message: (err as Error).message });
        }
      }
    }
  }

  /** Write one JSON-RPC line; throws synchronously when the child is gone. */
  private write(line: string): void {
    const child = this.child;
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.stdin.destroyed
    ) {
      throw new Error("zcode app-server is not running");
    }
    child.stdin.write(line, "utf8");
  }

  private replyToServer(id: string, method: string): void {
    const result =
      method === 'session/requestRuntimePreferences'
        ? { nativeSearchEnhancementsEnabled: false }
        : {};
    try {
      this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`, 'utf8');
    } catch {
      // Process may be exiting; nothing to salvage.
    }
  }

  private handleCrash(err: Error): void {
    this.crashed = err;
    this.child = undefined;
    this.startPromise = undefined;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method} aborted: ${err.message}`));
    }
    this.pending.clear();
    const waiters = this.crashWaiters;
    this.crashWaiters = [];
    for (const wake of waiters) wake();
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.ensureStarted().then(
      (child) =>
        new Promise<T>((resolve, reject) => {
          const id = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
          }, REQUEST_TIMEOUT_MS);
          this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, timer });
          try {
            child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8');
          } catch (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err as Error);
          }
        }),
    );
  }

  subscribe(sessionId: string, listener: SessionEventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  isAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.startPromise = undefined;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
