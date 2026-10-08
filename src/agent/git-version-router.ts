/**
 * git-version-router — a dependency-free stdio MCP server exposing READ-ONLY
 * git version queries for every repo under the given workspace roots.
 *
 * The strict-fs whitelist denies the agent's Bash tool, so historical
 * versions (tags / releases) are unreachable — the working tree holds one
 * branch and .git packfiles are zlib blobs no file tool can parse. This
 * router gives the agent a controlled, versioned read surface instead of
 * git itself:
 *
 *   git_list_projects / git_tags / git_read_file / git_log / git_diff / git_grep
 *
 * Security: only read-only git subcommands are allowed (show/log/tag/diff/
 * grep/ls-tree/cat-file/rev-parse); refs are sanitized to tag/branch/commit
 * charset (no flag injection); repos are constrained to scanned roots;
 * spawning uses fixed argv (no shell).
 *
 * Usage: node git-version-router.js <root1> [root2 ...]
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface GitRepo {
  project: string;
  repoPath: string;
}

const MAX_DEPTH = 2;

async function scanRepos(root: string, depth: number, out: GitRepo[], base = ''): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name === '.git') continue; // handled by the parent check below
    subdirs.push(e.name);
  }
  // .git is a hidden dir, readdir withFileTypes still lists it; check explicitly
  try {
    await readdir(join(root, '.git'));
    out.push({ project: base || '.', repoPath: root });
  } catch {
    // not a repo
  }
  if (depth >= MAX_DEPTH) return;
  for (const name of subdirs) {
    if (name === 'node_modules' || name === 'graphify-out') continue;
    await scanRepos(join(root, name), depth + 1, out, base ? `${base}/${name}` : name);
  }
}

/** Ref charset: tags, branches, commits (hex), and X.Y.Z version strings. */
const REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,127}$/;

function safeRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith('-') || !REF_RE.test(trimmed)) return undefined;
  return trimmed;
}

function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoPath, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      resolve('[timeout] git did not finish in 30s');
    }, 30_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve(`[error] failed to run git: ${e.message}`);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve((out || err || '[no output]').trim());
    });
  });
}

async function main(): Promise<void> {
  const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (roots.length === 0) {
    console.error('usage: git-version-router.js <workspace-root> [...]');
    process.exit(1);
  }
  const repos: GitRepo[] = [];
  for (const root of roots) await scanRepos(root, 0, repos);

  const findRepo = (name: string): GitRepo | undefined =>
    repos.find((r) => r.project === name) ??
    repos.find((r) => r.project.endsWith(`/${name}`)) ??
    repos.find((r) => r.project.toLowerCase().includes(name.toLowerCase()));

  const tools = [
    {
      name: 'git_list_projects',
      description: 'List every git repo in the workspace, with its current branch and tag count.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'git_tags',
      description: 'List tags/releases of one project (newest first). Optionally filter by pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'project id from git_list_projects' },
          pattern: { type: 'string', description: 'substring filter, e.g. "1.2"' },
        },
        required: ['project'],
        additionalProperties: false,
      },
    },
    {
      name: 'git_read_file',
      description: 'Read one file at a specific version (tag/branch/commit). Use for version-specific questions.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          ref: { type: 'string', description: 'tag, branch, or commit hash' },
          path: { type: 'string', description: 'repo-relative file path' },
        },
        required: ['project', 'ref', 'path'],
        additionalProperties: false,
      },
    },
    {
      name: 'git_log',
      description: 'Commit history at or before a ref (default current branch).',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          ref: { type: 'string', description: 'tag/branch/commit (default HEAD)' },
          limit: { type: 'number', description: 'max commits (default 20)' },
        },
        required: ['project'],
        additionalProperties: false,
      },
    },
    {
      name: 'git_diff',
      description: 'Diff between two versions (optionally limited to one path). Use for "what changed between A and B" questions.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          from: { type: 'string', description: 'older tag/branch/commit' },
          to: { type: 'string', description: 'newer tag/branch/commit' },
          path: { type: 'string', description: 'repo-relative file path filter (optional)' },
        },
        required: ['project', 'from', 'to'],
        additionalProperties: false,
      },
    },
    {
      name: 'git_grep',
      description: 'Search file CONTENTS at a specific version. Use for "which code calls X in version Y".',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          ref: { type: 'string', description: 'tag/branch/commit (default HEAD)' },
          pattern: { type: 'string', description: 'search string or regex' },
          glob: { type: 'string', description: 'file glob filter, e.g. "*.c" (optional)' },
        },
        required: ['project', 'pattern'],
        additionalProperties: false,
      },
    },
  ];

  const send = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const handleCall = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'git_list_projects': {
        if (repos.length === 0) return 'No git repos found under the workspace roots.';
        const lines: string[] = [];
        for (const r of repos.slice(0, 200)) {
          const branch = await runGit(r.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
          const tagCount = await runGit(r.repoPath, ['tag', '--list']);
          const n = tagCount.split('\n').filter(Boolean).length;
          lines.push(`- ${r.project} (branch: ${branch.trim()}, tags: ${n})`);
        }
        return lines.join('\n');
      }
      case 'git_tags': {
        const r = findRepo(String(args.project ?? ''));
        if (!r) return `unknown project "${args.project}" — run git_list_projects`;
        const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : '';
        const raw = await runGit(r.repoPath, [
          'tag',
          '--list',
          pattern ? `*${pattern}*` : '*',
          '--sort=-v:refname',
        ]);
        const tags = raw.split('\n').filter(Boolean).slice(0, 100);
        return tags.length === 0
          ? `No tags found${pattern ? ` matching "${pattern}"` : ''}.`
          : tags.join('\n');
      }
      case 'git_read_file': {
        const r = findRepo(String(args.project ?? ''));
        if (!r) return `unknown project "${args.project}" — run git_list_projects`;
        const ref = safeRef(String(args.ref ?? ''));
        if (!ref) return `invalid ref "${args.ref}" (tag/branch/commit only)`;
        const path = String(args.path ?? '').trim();
        if (!path || path.startsWith('-')) return `invalid path "${args.path}"`;
        return runGit(r.repoPath, ['show', `${ref}:${path}`]);
      }
      case 'git_log': {
        const r = findRepo(String(args.project ?? ''));
        if (!r) return `unknown project "${args.project}" — run git_list_projects`;
        const ref = args.ref !== undefined ? safeRef(String(args.ref)) : 'HEAD';
        if (!ref) return `invalid ref "${args.ref}"`;
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 20;
        return runGit(r.repoPath, [
          'log',
          `--oneline`,
          `-n`,
          String(limit),
          ref,
          '--',
        ]);
      }
      case 'git_diff': {
        const r = findRepo(String(args.project ?? ''));
        if (!r) return `unknown project "${args.project}" — run git_list_projects`;
        const from = safeRef(String(args.from ?? ''));
        const to = safeRef(String(args.to ?? ''));
        if (!from || !to) return `invalid from/to ref (tag/branch/commit only)`;
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const diffArgs = ['diff', `${from}...${to}`, '--stat'];
        const stat = await runGit(r.repoPath, diffArgs);
        if (!path) {
          // stat-only overview + first diff hunks
          const detail = await runGit(r.repoPath, ['diff', `${from}...${to}`, '-U3', '--', '.']);
          return `${stat}\n\n${detail}`.slice(0, 50_000);
        }
        if (path.startsWith('-')) return `invalid path "${args.path}"`;
        const detail = await runGit(r.repoPath, ['diff', `${from}...${to}`, '-U3', '--', path]);
        return detail || `(no changes in ${path} between ${from} and ${to})`;
      }
      case 'git_grep': {
        const r = findRepo(String(args.project ?? ''));
        if (!r) return `unknown project "${args.project}" — run git_list_projects`;
        const ref = args.ref !== undefined ? safeRef(String(args.ref)) : 'HEAD';
        if (!ref) return `invalid ref "${args.ref}"`;
        const pattern = String(args.pattern ?? '').trim();
        if (!pattern) return 'pattern is required';
        const grepArgs = ['grep', '-n', '-E', pattern, ref];
        if (typeof args.glob === 'string' && args.glob.trim()) {
          const glob = args.glob.trim();
          if (glob.startsWith('-')) return `invalid glob "${args.glob}"`;
          grepArgs.push('--', `*${glob.replace(/^\*+/, '')}`);
        }
        return runGit(r.repoPath, grepArgs);
      }
      default:
        return `unknown tool ${name}`;
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> & { name?: string; arguments?: Record<string, unknown> } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'git-version-router', version: '1.0.0' },
        },
      });
      return;
    }
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      return;
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const args = msg.params?.arguments ?? {};
      void handleCall(name, args).then((text) =>
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: String(text).slice(0, 60_000) }] },
        }),
      );
      return;
    }
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  });
}

void main();
