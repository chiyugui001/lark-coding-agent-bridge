import { describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/zcode/stream-json';

describe('zcode stream translator: ExitPlanMode', () => {
  it('surfaces the plan body as a text event so replies are not cut off', () => {
    const events = [
      ...translateEvent({
        type: 'model.streaming',
        sessionId: 's',
        payload: {
          kind: 'tool_call',
          toolCallId: 'call_1',
          toolName: 'ExitPlanMode',
          input: JSON.stringify({ plan: '步骤1：跑 sync\n步骤2：汇总结果' }),
        },
      }),
    ];
    const text = events.find((e) => e.type === 'text');
    expect(text).toMatchObject({
      type: 'text',
      delta: expect.stringContaining('步骤1：跑 sync'),
    });
    expect(events.some((e) => e.type === 'tool_use' && e.name === 'ExitPlanMode')).toBe(true);
  });

  it('passes ordinary tool calls through without extra text', () => {
    const events = [
      ...translateEvent({
        type: 'model.streaming',
        payload: { kind: 'tool_call', toolCallId: 'c2', toolName: 'Bash', input: '{"command":"ls"}' },
      }),
    ];
    expect(events.some((e) => e.type === 'text')).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('ignores ExitPlanMode without a usable plan', () => {
    const events = [
      ...translateEvent({
        type: 'model.streaming',
        payload: { kind: 'tool_call', toolCallId: 'c3', toolName: 'ExitPlanMode', input: '{}' },
      }),
    ];
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });
});
