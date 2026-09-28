import { describe, expect, it } from 'vitest';
import { consumeCotEvents, CotClient, CotPublisher, cotBriefToolTitle, finalAnswerOnlyState } from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';

describe('COT concise summary selection', () => {
  it('skips internal meta sentences and prefers the informative one', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client, chatId: 'oc_chat', originMessageId: 'om_o', runId: 'run-x', scope: 'oc_chat', inputPreview: 'p',
    });
    await publisher.start();
    await consumeCotEvents(iterate([
      { type: 'thinking', delta: 'Lead with the outcome: PDF 输出 = USB U盘模式下的《Data Report》加密 PDF 报告。Since this was a question, I just report findings and stop. No ExitPlanMode needed (research task, no implementation). Final message must contain everything.' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'concise' });
    const reasoning = client.events
      .filter((e) => e.event_type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => JSON.parse(e.content).delta);
    expect(reasoning).toEqual(['Lead with the outcome: PDF 输出 = USB U盘模式下的《Data Report》加密 PDF 报告。']);
  });
});

describe('COT concise mode', () => {
  it('condenses each reasoning burst to its last sentence, shows tool summaries, hides working text', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_o',
      runId: 'run-c',
      scope: 'oc_chat',
      inputPreview: 'p',
    });
    await publisher.start();
    await consumeCotEvents(iterate([
      { type: 'thinking', delta: '首先看工程结构。然后搜索关键词。最后确认根目录下只有 README.md 和 APP_UC701。' },
      { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'TS30' } },
      { type: 'tool_result', id: 't1', output: 'no matches', isError: false },
      { type: 'thinking', delta: '搜索没有结果。换个思路，检查 documents 目录。' },
      { type: 'text', delta: '中间工作文本不应显示。' },
      { type: 'final_text', content: '最终答案' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'concise' });

    const reasoning = client.events
      .filter((e) => e.event_type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => JSON.parse(e.content).delta);
    expect(reasoning).toEqual([
      '最后确认根目录下只有 README.md 和 APP_UC701。',
      '换个思路，检查 documents 目录。',
    ]);
    const all = client.events.map((e) => e.content).join(' ');
    expect(all).not.toContain('首先看工程结构');
    expect(all).not.toContain('中间工作文本');
    expect(all).not.toContain('no matches');
    const toolStart = client.events.find((e) => e.event_type === 'TOOL_CALL_START');
    expect(JSON.parse(toolStart?.content ?? '{}')).toMatchObject({ toolCallName: 'Grep' });
    expect(client.events.some((e) => e.event_type === 'TOOL_CALL_ARGS')).toBe(false);
  });
});

describe('COT minimal mode (read-only users)', () => {
  it('shows phase steps only — no reasoning text, working text, or tool details', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_o',
      runId: 'run-m',
      scope: 'oc_chat',
      inputPreview: 'p',
    });
    await publisher.start();
    await consumeCotEvents(iterate([
      { type: 'thinking', delta: 'The user wants to run graphify-sync.sh on D:/git/iot/sensor' },
      { type: 'text', delta: '我先看一下当前目录里的同步脚本，确认远端更新要跑什么。' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'D:/git/iot/sensor/graphify-sync.sh' } },
      { type: 'tool_result', id: 't1', output: '#!/bin/bash ... 102 repos', isError: false },
      { type: 'text', delta: '当前是只读模式，计划如下' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'minimal' });

    const types = client.events.map((e) => e.event_type);
    expect(types).not.toContain('REASONING_MESSAGE_CONTENT');
    expect(types).not.toContain('TEXT_MESSAGE_CONTENT');
    expect(types).not.toContain('TOOL_CALL_ARGS');
    const allContent = client.events.map((e) => e.content).join(' ');
    expect(allContent).not.toContain('graphify-sync.sh');
    expect(allContent).not.toContain('The user wants');
    expect(allContent).not.toContain('只读模式');
    const steps = client.events
      .filter((e) => e.event_type === 'STEP_STARTED')
      .map((e) => JSON.parse(e.content).stepName);
    expect(steps.slice(0, 3)).toEqual(['理解用户问题', '思考中', '整理回复']);
    expect(steps[steps.length - 1]).toMatch(/任务完成（耗时 \d+\.\ds）/);
    const toolStart = client.events.find((e) => e.event_type === 'TOOL_CALL_START');
    expect(JSON.parse(toolStart?.content ?? '{}')).toMatchObject({ title: '调用工具: Read', toolCallName: 'Read' });
    // args/output still hidden
    expect(client.events.map((e) => e.content).join(' ')).not.toContain('graphify-sync.sh');
  });
});

describe('COT event mapping', () => {
  it('publishes assistant progress text and brief tool summaries', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-1',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'draw a bear',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: '我会先生成图片。' },
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'echo bear' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'text', delta: '图片已经生成。' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_CONTENT');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(eventTypes).toContain('TOOL_CALL_START');
    expect(eventTypes).toContain('TOOL_CALL_RESULT');
    expect(eventTypes).not.toContain('TOOL_CALL_ARGS');

    const textDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta);
    expect(textDeltas).toEqual(['我会先生成图片。', '图片已经生成。']);

    const toolResult = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(toolResult?.content ?? '{}').content).toContain('command_execution');
    expect(client.completed).toEqual(['done']);
  });

  it('includes tool args and output only in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-2',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: 'workspace', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expect(client.events.map((event) => event.event_type)).toContain('TOOL_CALL_ARGS');
    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(result?.content ?? '{}').content).toBe('workspace');
  });

  it('derives final answer state from text blocks only', () => {
    const state: RunState = {
      blocks: [
        { kind: 'tool', tool: { id: 'tool', name: 'command_execution', input: {}, status: 'done' } },
        { kind: 'text', content: 'final', streaming: false },
      ],
      reasoning: { content: 'hidden', active: true },
      footer: 'streaming',
      terminal: 'done',
    };

    expect(finalAnswerOnlyState(state)).toMatchObject({
      blocks: [{ kind: 'text', content: 'final' }],
      reasoning: { content: '', active: false },
      footer: null,
    });
  });

  it('uses the legacy tool header format for brief COT titles', () => {
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('✅ command_execution');
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('echo hello');
  });

  it('creates the CoT bubble once, addressed to the origin message in a topic', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      // In a topic the trigger message is itself in-topic, so the bubble
      // inherits its thread. No thread_id is passed — message_cot rejects it.
      originMessageId: 'om_in_topic',
      runId: 'run-topic',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    // Exactly one create — never a second (that would render a duplicate).
    expect(client.createCalls).toEqual([
      { chatId: 'oc_chat', originMessageId: 'om_in_topic' },
    ]);
    expect(publisher.disabled).toBe(false);
  });

  it('disables the publisher when the create is rejected and never retries', async () => {
    const client = new FakeCotClient();
    client.failCreate = new Error('COT API failed: code=10002 msg=Bot/User can NOT be out of the chat.');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-rejected',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('disables the publisher when the create returns unusable ids and never retries', async () => {
    const client = new FakeCotClient();
    // code=0 response missing cot_id/message_id: the bubble may exist
    // server-side, so a second create would render a duplicate.
    client.createResult = { unexpected: 'shape' };
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-missing-ids',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('addresses CoT create to the chat with the origin message id', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // Intercept the HTTP layer so we assert only how create() shapes the request.
    (client as unknown as { request: CotClient['request'] }).request = async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return { cot_id: 'cot_x', message_id: 'om_x' };
    };

    await client.create('oc_chat', 'om_origin');
    expect(calls[0]?.path).toContain('receive_id_type=chat_id');
    // thread_id is never a valid receive type for message_cot.
    expect(calls[0]?.path).not.toContain('thread_id');
    expect(calls[0]?.body).toMatchObject({ receive_id: 'oc_chat', origin_message_id: 'om_origin' });
  });

  it('marks the publisher degraded when COT updates fail', async () => {
    const client = new FakeCotClient();
    client.failUpdate = new Error('field validation failed');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-degraded',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'working' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe('field validation failed');
    expect(client.completed).toEqual([]);
  });
});

class FakeCotClient {
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  completed: string[] = [];
  createCalls: Array<{ chatId: string; originMessageId?: string }> = [];
  failUpdate: Error | undefined;
  failCreate: Error | undefined;
  createResult: Record<string, unknown> | undefined;

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    this.createCalls.push({ chatId, originMessageId });
    if (this.failCreate) throw this.failCreate;
    return this.createResult ?? { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly { event_type: string; content: string; timestamp: number }[]): Promise<void> {
    if (this.failUpdate) throw this.failUpdate;
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}
