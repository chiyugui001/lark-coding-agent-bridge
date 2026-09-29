import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * graphify environment detection + optional auto-install.
 *
 * The knowledge-graph MCP router (lark-graph) needs the graphify CLI on the
 * machine. Deployments get a guided experience instead of a silent skip:
 *  - detectGraphify() — is the CLI reachable (PATH or ~/.local/bin)?
 *  - workspaceHasGraphs(root) — does the workspace carry graphify-out/ dirs?
 *  - installGraphify() — `uv tool install graphifyy` (the official channel).
 */
export function graphifyBinaryPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'graphify.exe' : 'graphify';
  const candidate = join(homedir(), '.local', 'bin', exe);
  if (existsSync(candidate)) return candidate;
  return undefined;
}

export async function detectGraphify(): Promise<boolean> {
  const local = graphifyBinaryPath();
  if (local) return true;
  return new Promise((resolve) => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', ['graphify'], {
      windowsHide: true,
    });
    probe.once('exit', (code) => resolve(code === 0));
    probe.once('error', () => resolve(false));
  });
}

export async function workspaceHasGraphs(root: string | undefined): Promise<boolean> {
  if (!root) return false;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (subdirs.some((e) => e.name === 'graphify-out')) return true;
    for (const e of subdirs) {
      if (e.name === 'node_modules') continue;
      try {
        const inner = await readdir(join(root, e.name), { withFileTypes: true });
        if (inner.some((c) => c.isDirectory() && c.name === 'graphify-out')) return true;
      } catch {
        // unreadable — skip
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Install graphify via uv. Resolves to true on success. */
export function installGraphify(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('uv', ['tool', 'install', 'graphifyy'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.once('error', () => resolve(false));
    child.once('exit', (code) => {
      if (code === 0) {
        console.log(out.trim().slice(-300));
        resolve(true);
      } else {
        console.error(out.trim().slice(-300));
        resolve(false);
      }
    });
  });
}
