/**
 * graphify-router — a dependency-free stdio MCP server that routes knowledge
 * graph queries to any graphify graph under the given workspace roots.
 *
 * One graphify MCP process serves a single graph.json, but workspaces like
 * sensor/ carry ~100 project graphs (roots/<line>/<project>/graphify-out).
 * This router scans the roots (two levels deep), indexes every graph, and
 * exposes query/path/explain tools that dispatch to the graphify CLI with a
 * `project` argument — so one mounted server covers the whole workspace.
 *
 * Usage: node graphify-router.js <root1> [root2 ...]
 * Tools: graph_list_projects | graph_stats | graph_query | graph_path | graph_explain
 */
import { spawn } from 'node:child_process';
import { readdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

interface GraphProject {
  project: string;
  graphPath: string;
}

const MAX_DEPTH = 2;

async function scanGraphs(root: string, depth: number, out: GraphProject[], base = ''): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name === 'graphify-out') {
      const graphPath = join(root, 'graphify-out', 'graph.json');
      if (existsSync(graphPath)) {
        out.push({ project: base || '.', graphPath });
      }
      continue;
    }
    subdirs.push(e.name);
  }
  if (depth >= MAX_DEPTH) return;
  for (const name of subdirs) {
    if (name === 'node_modules' || name === 'Middlewares' || name === 'Drivers') continue;
    await scanGraphs(join(root, name), depth + 1, out, base ? `${base}/${name}` : name);
  }
}

function findGraphifyBinary(): string {
  const exe = process.platform === 'win32' ? 'graphify.exe' : 'graphify';
  const candidates = [
    join(homedir(), '.local', 'bin', exe),
    exe, // rely on PATH
  ];
  for (const c of candidates) {
    if (c === exe) return c;
    if (existsSync(c)) return c;
  }
  return exe;
}

function runGraphify(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const bin = findGraphifyBinary();
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      resolve(`[timeout] graphify did not finish in 60s`);
    }, 60_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve(`[error] failed to run graphify: ${e.message}`);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve((out || err || '[no output]').trim());
    });
  });
}

async function main(): Promise<void> {
  const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (roots.length === 0) {
    console.error('usage: graphify-router.js <workspace-root> [...]');
    process.exit(1);
  }
  const projects: GraphProject[] = [];
  for (const root of roots) await scanGraphs(root, 0, projects);

  const findProject = (name: string): GraphProject | undefined =>
    projects.find((p) => p.project === name) ??
    projects.find((p) => p.project.endsWith(`/${name}`)) ??
    projects.find((p) => p.project.toLowerCase().includes(name.toLowerCase()));

  const tools = [
    {
      name: 'graph_list_projects',
      description: 'List every project in the workspace that has a graphify knowledge graph (use the exact project id for the other tools).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'graph_query',
      description:
        'BFS knowledge-graph search in one project: natural-language question about code structure/call flow. Prefer this over reading source files. budget caps the token output (default 2000).',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'project id from graph_list_projects' },
          question: { type: 'string' },
          budget: { type: 'number', description: 'token budget (default 2000)' },
        },
        required: ['project', 'question'],
        additionalProperties: false,
      },
    },
    {
      name: 'graph_path',
      description: 'Shortest call path between two symbols in one project graph.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['project', 'from', 'to'],
        additionalProperties: false,
      },
    },
    {
      name: 'graph_explain',
      description: 'Plain-language explanation of a symbol and its neighbors in one project graph.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          symbol: { type: 'string' },
        },
        required: ['project', 'symbol'],
        additionalProperties: false,
      },
    },
  ];

  const send = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const handleCall = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'graph_list_projects':
        return projects.length === 0
          ? 'No graphify graphs found under the workspace roots.'
          : projects.map((p) => `- ${p.project}`).join('\n');
      case 'graph_query': {
        const p = findProject(String(args.project ?? ''));
        if (!p) return `unknown project "${args.project}" — run graph_list_projects`;
        const budget = typeof args.budget === 'number' ? String(Math.floor(args.budget)) : '2000';
        return runGraphify([
          'query',
          String(args.question ?? ''),
          '--graph',
          p.graphPath,
          '--budget',
          budget,
        ]);
      }
      case 'graph_path': {
        const p = findProject(String(args.project ?? ''));
        if (!p) return `unknown project "${args.project}" — run graph_list_projects`;
        return runGraphify(['path', String(args.from ?? ''), String(args.to ?? ''), '--graph', p.graphPath]);
      }
      case 'graph_explain': {
        const p = findProject(String(args.project ?? ''));
        if (!p) return `unknown project "${args.project}" — run graph_list_projects`;
        return runGraphify(['explain', String(args.symbol ?? ''), '--graph', p.graphPath]);
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
          serverInfo: { name: 'graphify-router', version: '1.0.0' },
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
