import { afterEach, describe, expect, it, vi } from 'vitest';

// The adapter syncs the engine's on-disk config at the top of every run —
// keep the unit test away from the real ~/.zcode config.
vi.mock('../../../src/agent/zcode/fs-sandbox', () => ({
  syncZcodeFsWhitelist: () => false,
}));

import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import type { AppServerSessionEvent } from '../../../src/agent/zcode/app-server';
import type { AgentEvent, AgentRunOptions } from '../../../src/agent/types';

type Listener = (event: AppServerSessionEvent) => void;

class FakeAppServerClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly nextCrash: Promise<void> = new Promise(() => undefined);
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly responders = new Map<string, (params: Record<string, unknown>) => unknown>();

  on(method: string, responder: (params: Record<string, unknown>) => unknown): void {
    this.responders.set(method, responder);
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const responder = this.responders.get(method);
    if (!responder) return Promise.reject(new Error(`${method} failed: no responder`));
    return Promise.resolve(responder(params) as T);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
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

  hasListener(sessionId: string): boolean {
    return (this.listeners.get(sessionId)?.size ?? 0) > 0;
  }

  emit(event: AppServerSessionEvent): void {
    const set = this.listeners.get(event.sessionId ?? '');
    if (!set) return;
    for (const listener of set) listener(event);
  }
}

function makeAdapter(client: FakeAppServerClient): ZcodeAdapter {
  const adapter = new ZcodeAdapter({ transport: 'app-server', desktopSync: false });
  (adapter as unknown as { client: unknown }).client = client;
  return adapter;
}

function runOpts(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    runId: 'run-test',
    prompt: '你好',
    cwd: '/tmp/ws',
    permissionMode: 'plan',
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ZcodeAdapter app-server transport: event subscription', () => {
  it('fresh sessions subscribe before send and complete normally', async () => {
    const client = new FakeAppServerClient();
    client.on('session/create', () => ({ session: { sessionId: 'sess_fresh' } }));
    client.on('session/setMode', () => ({}));
    client.on('session/subscribe', () => ({}));
    client.on('session/send', () => {
      queueMicrotask(() =>
        client.emit({
          sessionId: 'sess_fresh',
          type: 'turn.completed',
          payload: { response: '答复内容' },
        }),
      );
      return {};
    });

    const run = makeAdapter(client).run(runOpts());
    const events = await collect(run.events);

    expect(client.calls).toContainEqual({
      method: 'session/subscribe',
      params: { sessionId: 'sess_fresh', deliveryKind: 'desktop-continuous' },
    });
    expect(events.some((e) => e.type === 'final_text')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess_fresh' });
  });

  it('resumed sessions re-register the listener so engine events reach the run', async () => {
    const client = new FakeAppServerClient();
    client.on('session/resume', () => ({}));
    client.on('session/setMode', () => ({}));
    client.on('session/subscribe', () => ({}));
    client.on('session/send', () => {
      queueMicrotask(() =>
        client.emit({
          sessionId: 'sess_resume',
          type: 'turn.completed',
          payload: { response: '续接答复' },
        }),
      );
      return {};
    });

    const run = makeAdapter(client).run(runOpts({ sessionId: 'sess_resume' }));
    const events = await collect(run.events);

    // Regression: the resume path used to skip client.subscribe +
    // session/subscribe entirely — the run went deaf and only ended on the
    // 5-minute idle watchdog.
    expect(client.calls).toContainEqual({
      method: 'session/subscribe',
      params: { sessionId: 'sess_resume', deliveryKind: 'desktop-continuous' },
    });
    expect(events.some((e) => e.type === 'final_text')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess_resume' });
  });

  it('stale resume falls through to a fresh, subscribed session', async () => {
    const client = new FakeAppServerClient();
    client.on('session/resume', () => Promise.reject(new Error('session not found')));
    client.on('session/create', () => ({ session: { sessionId: 'sess_recovered' } }));
    client.on('session/setMode', () => ({}));
    client.on('session/subscribe', () => ({}));
    client.on('session/send', () => {
      queueMicrotask(() =>
        client.emit({
          sessionId: 'sess_recovered',
          type: 'turn.completed',
          payload: { response: '新会话答复' },
        }),
      );
      return {};
    });

    const run = makeAdapter(client).run(runOpts({ sessionId: 'sess_stale' }));
    const events = await collect(run.events);

    expect(client.calls).toContainEqual({
      method: 'session/subscribe',
      params: { sessionId: 'sess_recovered', deliveryKind: 'desktop-continuous' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess_recovered' });
  });
});

describe('ZcodeAdapter app-server transport: idle watchdog', () => {
  it('cancels the engine-side prompt so the session is not left locked', async () => {
    vi.useFakeTimers();
    const client = new FakeAppServerClient();
    client.on('session/resume', () => ({}));
    client.on('session/setMode', () => ({}));
    client.on('session/subscribe', () => ({}));
    client.on('session/send', () => ({}));
    client.on('session/stop', () => ({}));

    const run = makeAdapter(client).run(runOpts({ sessionId: 'sess_wedge' }));
    const collected = collect(run.events);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const events = await collected;

    expect(events.some((e) => e.type === 'error')).toBe(true);
    // Regression: the watchdog used to only fabricate a local failure —
    // the engine kept the prompt running and every retry hit
    // "A prompt is already running for this session".
    expect(client.calls).toContainEqual({
      method: 'session/stop',
      params: { sessionId: 'sess_wedge' },
    });
  });
});
