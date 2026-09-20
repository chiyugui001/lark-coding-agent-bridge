import type { AgentEvent } from '../types';

/**
 * Wire format of `zcode --output-format stream-json`: one JSON object per
 * stdout line. Session-level events carry `sessionId`/`turnId` at the top
 * level and the kind-specific data under `payload`. The final line is a
 * `{ type: "result", ... }` summary emitted after the turn completes.
 */
interface ZcodeRawEvent {
  type?: string;
  sessionId?: string;
  turnId?: string;
  payload?: {
    kind?: string;
    delta?: string;
    response?: string;
    input?: string;
    toolCallId?: string;
    toolName?: string;
    result?: { success?: boolean; content?: unknown };
    usage?: ZcodeUsage;
    [key: string]: unknown;
  };
  usage?: ZcodeUsage;
}

interface ZcodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

function usageEvent(u: ZcodeUsage | undefined): AgentEvent[] {
  if (!u) return [];
  return [
    {
      type: 'usage',
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedInputTokens: u.cacheReadTokens,
      reasoningOutputTokens: u.reasoningTokens,
    },
  ];
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ZcodeRawEvent;
  const payload = evt.payload ?? {};

  switch (evt.type) {
    case 'turn.started':
      yield { type: 'system', sessionId: evt.sessionId, threadId: evt.turnId };
      return;

    case 'model.streaming':
      switch (payload.kind) {
        case 'text_delta':
          if (payload.delta) yield { type: 'text', delta: payload.delta };
          return;
        case 'reasoning_delta':
          if (payload.delta) yield { type: 'thinking', delta: payload.delta };
          return;
        case 'tool_call':
          if (payload.toolCallId && payload.toolName) {
            yield {
              type: 'tool_use',
              id: payload.toolCallId,
              name: payload.toolName,
              input: payload.input ? tryParseJson(payload.input) : payload.input,
            };
          }
          return;
        default:
          return;
      }

    case 'tool.updated':
      if (payload.kind === 'result' && payload.toolCallId) {
        const content = payload.result?.content;
        yield {
          type: 'tool_result',
          id: payload.toolCallId,
          output: typeof content === 'string' ? content : JSON.stringify(content),
          isError: payload.result?.success !== true,
        };
      }
      return;

    case 'turn.completed':
      if (typeof payload.response === 'string' && payload.response) {
        yield { type: 'final_text', content: payload.response };
      }
      yield* usageEvent(payload.usage);
      return;

    case 'result':
      yield* usageEvent(evt.usage);
      yield { type: 'done', sessionId: evt.sessionId, terminationReason: 'normal' };
      return;
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
