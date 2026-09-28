import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-user persistent memory files for the bridge. One markdown file per
 * Feishu open_id under the profile's memory directory; content is injected
 * into the agent prompt as a <user_memory> block, and write-privileged
 * agents may edit their user's file directly (the path is disclosed to
 * them in the prompt).
 */
export const DEFAULT_MEMORY_INJECT_MAX_BYTES = 8 * 1024;

function sanitizeUserId(senderId: string): string {
  const clean = senderId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) throw new Error('invalid sender id for memory file');
  return clean;
}

export class MemoryStore {
  private readonly baseDir: string;
  private readonly injectMaxBytes: number;

  constructor(baseDir: string, injectMaxBytes = DEFAULT_MEMORY_INJECT_MAX_BYTES) {
    this.baseDir = baseDir;
    this.injectMaxBytes = injectMaxBytes;
  }

  pathFor(senderId: string): string {
    return join(this.baseDir, `${sanitizeUserId(senderId)}.md`);
  }

  /** Current memory content for the user; empty string when absent. */
  async get(senderId: string): Promise<string> {
    try {
      return (await readFile(this.pathFor(senderId), 'utf8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Content capped at the injection limit (truncation-safe on char level). */
  async getForInjection(senderId: string): Promise<string> {
    const content = await this.get(senderId);
    if (content.length <= this.injectMaxBytes) return content;
    return content.slice(0, this.injectMaxBytes);
  }

  async append(senderId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('memory append requires non-empty text');
    const current = await this.get(senderId);
    const next = current ? `${current}\n${trimmed}` : trimmed;
    await this.ensureDir();
    await writeFile(this.pathFor(senderId), next, 'utf8');
  }

  async clear(senderId: string): Promise<void> {
    await this.ensureDir();
    await writeFile(this.pathFor(senderId), '', 'utf8');
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }
}
