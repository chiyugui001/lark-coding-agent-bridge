import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { stat as statFile } from 'node:fs/promises';
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
  /** Serializes file writes so concurrent appends cannot clobber each other. */
  private writeChain: Promise<void> = Promise.resolve();

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

  /** Run an async mutation on the serialized write chain. */
  private enqueueWrite(run: () => Promise<void>): Promise<void> {
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  async append(senderId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('memory append requires non-empty text');
    await this.enqueueWrite(async () => {
      const current = await this.get(senderId);
      const next = current ? `${current}\n${trimmed}` : trimmed;
      await this.ensureDir();
      await writeFile(this.pathFor(senderId), next, 'utf8');
    });
  }

  clear(senderId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.ensureDir();
      await writeFile(this.pathFor(senderId), '', 'utf8');
    });
  }

  /** All stored memories: sanitized user id, size, mtime, and a short preview. */
  async list(): Promise<{ userId: string; bytes: number; modifiedAt: number; preview: string }[]> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return [];
    }
    const out: { userId: string; bytes: number; modifiedAt: number; preview: string }[] = [];
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const userId = name.slice(0, -3);
      const path = join(this.baseDir, name);
      try {
        const [stat, content] = await Promise.all([statFile(path), readFile(path, 'utf8')]);
        out.push({
          userId,
          bytes: stat.size,
          modifiedAt: stat.mtimeMs,
          preview: content.trim().slice(0, 120),
        });
      } catch {
        // unreadable entry — skip
      }
    }
    out.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return out;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }
}
