import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt, prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import type { ClaudePermissionMode } from '../types';
import { translateEvent } from './stream-json';
import { ZcodeAppServerClient, type AppServerSessionEvent } from './app-server';
import { upsertDesktopTask } from './desktop-sync';

export type ZcodeTransport = 'app-server' | 'cli';

export interface ZcodeAdapterOptions {
  binary?: string;
  /**
   * Transport to the zcode engine. `app-server` (default) keeps one
   * long-lived `zcode app-server` process and multiplexes sessions over the
   * ZCode Protocol — the same engine the desktop app uses. `cli` spawns a
   * one-shot `zcode --prompt` process per run.
   */
  transport?: ZcodeTransport;
  /** Mirror bridge sessions into the ZCode desktop app's task list. Default true. */
  desktopSync?: boolean;
  larkChannel?: LarkChannelEnvContext;
}

type ZcodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/** Default headless CLI location of the ZCode desktop install on Windows. */
function defaultCjsPath(): string | undefined {
  const candidate = join(
    homedir(),
    'AppData',
    'Local',
    'Programs',
    'ZCode',
    'resources',
    'glm',
    'zcode.cjs',
  );
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Resolve how to invoke the zcode CLI. A `.cjs` bundle must be run through
 * node itself — that also keeps the prompt out of `cmd.exe`, whose `<`/`>`
 * handling would corrupt argv on Windows.
 */
function resolveInvocation(binary: string): { command: string; preArgs: string[] } {
  if (binary.endsWith('.cjs')) {
    return { command: process.execPath, preArgs: [binary] };
  }
  return { command: binary, preArgs: [] };
}

export class ZcodeAdapter implements AgentAdapter {
  readonly id = 'zcode';
  readonly displayName = 'ZCode';

  private readonly binary: string;
  private readonly transport: ZcodeTransport;
  private readonly desktopSync: boolean;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;
  private client: ZcodeAppServerClient | undefined;

  constructor(opts: ZcodeAdapterOptions = {}) {
    this.binary = opts.binary ?? defaultCjsPath() ?? 'zcode';
    this.transport = opts.transport ?? 'app-server';
    this.desktopSync = opts.desktopSync !== false;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    const { command, preArgs } = resolveInvocation(this.binary);
    return checkAgentAvailability({
      agentId: 'zcode',
      agentName: 'ZCode',
      command: this.binary,
      binaryPath: command,
      args: [...preArgs, '--version'],
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ZcodeAdapter.run');
    }
    return this.transport === 'app-server' ? this.runViaAppServer(opts) : this.runViaCli(opts);
  }

  private runViaAppServer(opts: AgentRunOptions): AgentRun {
    const { command, preArgs } = resolveInvocation(this.binary);
    this.client ??= new ZcodeAppServerClient({
      command,
      preArgs,
      larkChannel: this.larkChannel,
    });
    const client = this.client;
    const prompt =
      this.transport === 'app-server'
        ? buildZcodePrompt(opts.prompt, this.botIdentity)
        : prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);

    // stop() may be called before the session id is known; share a holder.
    let sessionId: string | undefined;
    let settled = false;
    let settleRun: (() => void) | undefined;
    const runSettled = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    const markSettled = (): void => {
      if (!settled) {
        settled = true;
        settleRun?.();
      }
    };

    const desktopSync = this.desktopSync;
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      try {
        if (opts.sessionId) {
          try {
            await client.request('session/resume', { sessionId: opts.sessionId });
            sessionId = opts.sessionId;
          } catch {
            sessionId = undefined; // stale session id — fall through to create
          }
        }
        if (!sessionId) {
          const created = await client.request<{ session?: { sessionId?: string } }>(
            'session/create',
            { workspace: { workspaceKey: opts.cwd, workspacePath: opts.cwd } },
          );
          sessionId = created?.session?.sessionId;
        }
        if (!sessionId) throw new Error('zcode app-server returned no sessionId');

        // Bridge chats run unattended; yolo skips interactive permission gates.
        await client
          .request('session/setMode', { sessionId, mode: zcodeModeFor(opts.permissionMode) })
          .catch(() => undefined);

        // Buffer events between subscription setup and generator consumption.
        const queue: AppServerSessionEvent[] = [];
        let wake: (() => void) | undefined;
        const waiters: Array<() => void> = [];
        const unsubscribe = client.subscribe(sessionId, (event) => {
          queue.push(event);
          while (waiters.length) waiters.shift()!();
        });
        try {
          await client.request('session/subscribe', {
            sessionId,
            deliveryKind: 'desktop-continuous',
          });
          // The translator emits the `system` event from the turn.started
          // notification right after session/send.
          log.info('agent', 'app-server-send', {
            sessionId,
            hasResume: Boolean(opts.sessionId),
            promptChars: prompt.length,
          });
          if (desktopSync) {
            upsertDesktopTask({
              sessionId,
              workspacePath: opts.cwd!,
              title: taskTitle(opts.prompt),
              status: 'running',
            });
          }
          await client.request('session/send', { sessionId, content: prompt });

          while (true) {
            while (queue.length === 0) {
              await Promise.race([
                new Promise<void>((resolve) => {
                  waiters.push(resolve);
                  wake = resolve;
                }),
                client.nextCrash.then(() => {
                  throw new Error("zcode app-server process exited mid-turn");
                }),
              ]);
              wake = undefined;
            }
            const event = queue.shift()!;
            if (event.type === 'turn.completed') {
              yield* translateEvent(event);
              // Sync BEFORE the terminal done yield — consumers stop pulling
              // events at done, so anything after that yield never runs.
              if (desktopSync) {
                upsertDesktopTask({
                  sessionId,
                  workspacePath: opts.cwd!,
                  title: taskTitle(opts.prompt),
                  status: 'completed',
                });
              }
              yield { type: 'done', sessionId, terminationReason: 'normal' };
              return;
            }
            if (event.type === 'turn.failed' || event.type === 'turn.cancelled') {
              if (desktopSync) {
                upsertDesktopTask({
                  sessionId,
                  workspacePath: opts.cwd!,
                  title: taskTitle(opts.prompt),
                  status: 'error',
                });
              }
              yield {
                type: 'error',
                message: `zcode turn ${event.type === 'turn.failed' ? 'failed' : 'cancelled'}: ${JSON.stringify(event.payload ?? {}).slice(0, 300)}`,
                terminationReason: 'interrupted',
              };
              return;
            }
            yield* translateEvent(event);
          }
        } finally {
          unsubscribe();
          markSettled();
        }
      } catch (err) {
        yield {
          type: 'error',
          message: `zcode app-server error: ${(err as Error).message}`,
          terminationReason: 'failed',
        };
      } finally {
        markSettled();
      }
    })();

    return {
      runId: opts.runId,
      events,
      async stop() {
        try {
          if (sessionId) await client.request('session/stop', { sessionId });
        } catch (err) {
          log.warn('agent', 'app-server-stop-failed', { message: (err as Error).message });
        }
        markSettled();
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return Promise.race([
          runSettled.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
      },
    };
  }

  private runViaCli(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ZcodeAdapter.run');
    }
    const { command, preArgs } = resolveInvocation(this.binary);
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);

    const args = [
      ...preArgs,
      '--prompt',
      prompt,
      '--output-format',
      'stream-json',
      '--mode',
      zcodeModeFor(opts.permissionMode),
      '--cwd',
      opts.cwd,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    for (const image of opts.images ?? []) args.push('--attach', image);

    const child = spawnProcess(command, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ZcodeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn zcode: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: ZcodeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn zcode: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `zcode runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `zcode exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `zcode runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

/** Map the bridge permission mode to a zcode mode; plan is read-only. */
function zcodeModeFor(permissionMode: ClaudePermissionMode | undefined): string {
  if (permissionMode === 'bypassPermissions') return 'yolo';
  if (permissionMode === 'acceptEdits') return 'edit';
  return 'plan';
}

/** Strip an XML block (open/close tags) from the text. */
function stripXmlBlock(text: string, tag: string): string {
  const start = text.indexOf(`<${tag}>`);
  if (start < 0) return text;
  const end = text.indexOf(`</${tag}>`, start);
  if (end < 0) return text;
  return text.slice(end + tag.length + 3).trim();
}

/**
 * Task-list title from the raw user prompt. Bridge prompts carry
 * <bridge_context>/<bridge_instructions> XML blocks and may wrap the message
 * in <user_input>{"text": ...}</user_input>; extract the human message first.
 */
function taskTitle(prompt: string): string {
  let text = prompt.trim();
  text = stripXmlBlock(text, "bridge_context");
  text = stripXmlBlock(text, "bridge_instructions");
  const uiStart = text.indexOf("<user_input>");
  if (uiStart >= 0) {
    const uiEnd = text.indexOf("</user_input>", uiStart);
    let inner = text.slice(uiStart + "<user_input>".length, uiEnd >= 0 ? uiEnd : undefined).trim();
    try {
      const parsed = JSON.parse(inner) as { text?: unknown };
      if (typeof parsed.text === "string") inner = parsed.text;
    } catch {
      // plain text
    }
    if (inner) text = inner;
  }
  const firstLine = text.split(String.fromCharCode(10), 1)[0] ?? text;
  const title = `飞书: ${firstLine}`;
  return title.length > 60 ? title.slice(0, 60) + "…" : title;
}

/**
 * zcode derives the session title from the start of the first input, so the
 * user message leads and the bridge system prompt is appended after it.
 */
function buildZcodePrompt(prompt: string, identity: AgentBotIdentity | undefined): string {
  return `${prompt}\n\n## bridge_system_prompt\n\n${buildBridgeSystemPrompt(identity)}`;
}
