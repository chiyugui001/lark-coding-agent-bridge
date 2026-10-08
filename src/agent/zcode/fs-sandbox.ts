import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/logger';

/**
 * Strict directory mode for the zcode agent, modeled after the official
 * `@modelcontextprotocol/server-filesystem` MCP server:
 *
 *  - mount that server with the configured allowed directories (it validates
 *    every operation: realpath + containment + symlink-escape checks);
 *  - deny the engine's NATIVE file/shell tools (Read/Grep/Glob/Edit/Write/
 *    Bash) so nothing can bypass the whitelist — without this the sandbox is
 *    decorative, since `ls <anywhere>` would still work.
 *
 * The managed entries live in ~/.zcode/cli/config.json (the CLI-side engine
 * config; the desktop app uses ~/.zcode/v2 and is untouched). Only our own
 * keys are added/removed; unrelated user config is preserved. The whitelist
 * is fixed at app-server startup — the adapter restarts the app-server when
 * the synced config changes.
 */
export interface FsWhitelistConfig {
  enabled: boolean;
  dirs?: string[];
}

const MCP_SERVER_KEY = 'lark-fs';
const NATIVE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] as const;

function shouldHaveSubagentOff(sandbox: FsWhitelistConfig | undefined): boolean {
  return sandbox?.enabled === true;
}

function engineConfigPath(): string {
  return join(homedir(), '.zcode', 'cli', 'config.json');
}

function readRaw(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Sync the engine config for the sandbox; true when the file changed. */
export function syncZcodeFsWhitelist(sandbox: FsWhitelistConfig | undefined, defaultDir: string): boolean {
  const path = engineConfigPath();
  if (!existsSync(path)) return false; // engine config missing — nothing to sync onto
  const raw = readRaw(path);
  let changed = false;

  const mcp = (raw.mcp ?? {}) as { servers?: Record<string, unknown> };
  const servers = mcp.servers ?? {};
  if (sandbox?.enabled && (sandbox.dirs?.length ?? 0) > 0) {
    const dirs = sandbox.dirs!.map((d) => d.trim()).filter(Boolean);
    const desired = {
      type: 'stdio',
      // Windows needs the cmd shim for npx; POSIX spawns npx directly.
      ...(process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', ...dirs] }
        : { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', ...dirs] }),
      enabled: true,
    };
    if (JSON.stringify(servers[MCP_SERVER_KEY]) !== JSON.stringify(desired)) {
      servers[MCP_SERVER_KEY] = desired;
      changed = true;
    }
  } else if (MCP_SERVER_KEY in servers) {
    delete servers[MCP_SERVER_KEY];
    changed = true;
  }

  // Graph router MCP: graphify knowledge-graph query tools for the whole
  // workspace (one process routes every project graph under the roots).
  // Mounted only while the whitelist is on and the router bundle exists.
  const wlDirs = (sandbox?.dirs?.length ? sandbox.dirs : [defaultDir]).map((d) => d.trim()).filter(Boolean);
  // tsup bundles everything into dist/cli.js (no dist/agent/zcode/ nesting),
  // so walk upward from this module's location to find the sibling router.
  let routerPath: string | undefined;
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir && dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'graphify-router.js');
    if (existsSync(candidate)) {
      routerPath = candidate;
      break;
    }
  }
  if (sandbox?.enabled && wlDirs.length > 0 && routerPath) {
    const desiredRouter = {
      type: 'stdio',
      command: process.execPath,
      args: [routerPath, ...wlDirs],
      enabled: true,
    };
    if (JSON.stringify(servers['lark-graph']) !== JSON.stringify(desiredRouter)) {
      servers['lark-graph'] = desiredRouter;
      changed = true;
    }
  } else if ('lark-graph' in servers) {
    delete servers['lark-graph'];
    changed = true;
  }

  // Git version router MCP: read-only tag/branch/commit queries (show/log/
  // tag/diff/grep) so version-specific questions work without Bash.
  let gitRouterPath: string | undefined;
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir && dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'git-version-router.js');
    if (existsSync(candidate)) {
      gitRouterPath = candidate;
      break;
    }
  }
  if (sandbox?.enabled && wlDirs.length > 0 && gitRouterPath) {
    const desiredGit = {
      type: 'stdio',
      command: process.execPath,
      args: [gitRouterPath, ...wlDirs],
      enabled: true,
    };
    if (JSON.stringify(servers['lark-git']) !== JSON.stringify(desiredGit)) {
      servers['lark-git'] = desiredGit;
      changed = true;
    }
  } else if ('lark-git' in servers) {
    delete servers['lark-git'];
    changed = true;
  }
  if (changed) {
    mcp.servers = servers;
    raw.mcp = mcp;
  }

  // Subagents carry their own tool sets and ignore the main-session deny
  // list — disable the capability outright while the whitelist is on.
  const features = (raw.features ?? {}) as Record<string, unknown>;
  if (shouldHaveSubagentOff(sandbox) && features.subagent !== false) {
    features.subagent = false;
    raw.features = features;
    changed = true;
  } else if (!shouldHaveSubagentOff(sandbox) && features.subagent === false) {
    delete features.subagent;
    raw.features = features;
    changed = true;
  }

  // Desktop-control plugins are another bypass surface (screenshots, mouse/
  // keyboard); deny them while the whitelist is on. Left untouched when off.
  const plugins = (raw.plugins ?? {}) as { enabledPlugins?: Record<string, boolean> };
  const enabledPlugins = plugins.enabledPlugins ?? {};
  const DESKTOP_PLUGINS = [
    'computer-use@zcode-plugins-official',
    'browser-use@zcode-plugins-official',
  ];
  if (sandbox?.enabled) {
    for (const key of DESKTOP_PLUGINS) {
      if (enabledPlugins[key] !== false) {
        enabledPlugins[key] = false;
        changed = true;
      }
    }
  }
  if (changed) {
    plugins.enabledPlugins = enabledPlugins;
    raw.plugins = plugins;
  }

  const permission = (raw.permission ?? {}) as { disallowedTools?: string[] };
  const current = permission.disallowedTools ?? [];
  const ours = new Set<string>(NATIVE_TOOLS);
  const shouldHave = sandbox?.enabled === true;
  const has = current.filter((t) => ours.has(t));
  let next = current;
  if (shouldHave && has.length < NATIVE_TOOLS.length) {
    next = [...new Set([...current, ...NATIVE_TOOLS])];
    changed = true;
  } else if (!shouldHave && has.length > 0) {
    next = current.filter((t) => !ours.has(t));
    changed = true;
  }
  if (next !== current) {
    permission.disallowedTools = next;
    raw.permission = permission;
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(raw, null, 2), 'utf8');
    log.info('agent', 'fs-whitelist-synced', {
      enabled: sandbox?.enabled === true,
      dirs: sandbox?.dirs ?? [defaultDir],
    });
  }
  return changed;
}
