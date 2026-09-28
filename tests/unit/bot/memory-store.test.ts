import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/bot/memory-store';
import { buildAgentPrompt } from '../../../src/agent/prompt';

const dirs: string[] = [];
function store(maxBytes = 8192): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
  dirs.push(dir);
  return new MemoryStore(dir, maxBytes);
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('MemoryStore', () => {
  it('returns empty for unknown users and round-trips append', async () => {
    const m = store();
    expect(await m.get('ou_a')).toBe('');
    await m.append('ou_a', '我喜欢简洁的回复');
    await m.append('ou_a', '项目在 D:\\git\\iot\\sensor');
    expect(await m.get('ou_a')).toBe('我喜欢简洁的回复\n项目在 D:\\git\\iot\\sensor');
    expect(await m.get('ou_b')).toBe('');
  });

  it('isolates users into separate files', async () => {
    const m = store();
    await m.append('ou_a', 'A 的记忆');
    await m.append('ou_b', 'B 的记忆');
    expect(await m.get('ou_a')).toBe('A 的记忆');
    expect(await m.get('ou_b')).toBe('B 的记忆');
    expect(m.pathFor('ou_a')).not.toBe(m.pathFor('ou_b'));
  });

  it('sanitizes unsafe id characters in file names', () => {
    const m = store();
    const p = m.pathFor('ou_abc../../evil');
    expect(p).not.toContain('..');
    expect(p.endsWith('.md')).toBe(true);
  });

  it('truncates injected content at the configured byte budget', async () => {
    const m = store(10);
    await m.append('ou_a', '0123456789ABCDEF');
    expect((await m.getForInjection('ou_a')).length).toBeLessThanOrEqual(10);
    expect(await m.get('ou_a')).toBe('0123456789ABCDEF');
  });

  it('clear empties the memory', async () => {
    const m = store();
    await m.append('ou_a', 'x');
    await m.clear('ou_a');
    expect(await m.get('ou_a')).toBe('');
    expect(existsSync(m.pathFor('ou_a'))).toBe(true);
  });

  it('append rejects empty text', async () => {
    const m = store();
    await expect(m.append('ou_a', '   ')).rejects.toThrow(/non-empty/);
  });

  it('persists to disk as plain markdown', async () => {
    const m = store();
    await m.append('ou_a', '落地检查');
    expect(readFileSync(m.pathFor('ou_a'), 'utf8')).toBe('落地检查');
  });
});

describe('buildAgentPrompt userMemory', () => {
  const base = {
    context: {
      chatId: 'oc_x',
      chatType: 'p2p' as const,
      senderId: 'ou_x',
      messageIds: ['om_x'],
      source: 'im' as const,
    },
    userInput: 'hi',
  };

  it('renders a user_memory block after bridge_context', () => {
    const p = buildAgentPrompt({ ...base, userMemory: { content: '用户偏好中文' } });
    const ctxIdx = p.indexOf('<bridge_context>');
    const memIdx = p.indexOf('<user_memory>');
    expect(memIdx).toBeGreaterThan(ctxIdx);
    expect(p).toContain('用户偏好中文');
    expect(p).not.toContain('memory_file');
  });

  it('discloses the memory file path only when provided (write users)', () => {
    const path = 'C:' + String.fromCharCode(92) + 'mem' + String.fromCharCode(92) + 'ou_a.md';
    const p = buildAgentPrompt({
      ...base,
      userMemory: { content: 'x', memoryFilePath: path },
    });
    expect(p).toContain('memory_file');
    // JSON-encoded inside the block, so backslashes are doubled
    expect(p).toContain(path.split(String.fromCharCode(92)).join(String.fromCharCode(92,92)));
  });

  it('omits the block entirely when userMemory is not provided', () => {
    const p = buildAgentPrompt(base);
    expect(p).not.toContain('<user_memory>');
  });

  it('renders the protocol note even with empty memory content', () => {
    const p = buildAgentPrompt({ ...base, userMemory: { content: '' } });
    expect(p).toContain('<user_memory>');
    expect(p).toContain('memory_write_protocol');
    expect(p).toContain('memory_write');
    // angle brackets are JSON-escaped inside the block
    expect(p).not.toContain('<user_memory>undefined');
  });
});
