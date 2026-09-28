import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', ...dirs],
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
