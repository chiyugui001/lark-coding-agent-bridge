import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export type AgentKind = 'claude' | 'codex' | 'zcode';

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

export async function resolveExecutablePath(command: string): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(dir, command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`executable not found: ${command}`);
}

function executableCandidates(dir: string, command: string): string[] {
  const candidates = [join(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of pathExts()) {
    candidates.push(join(dir, `${command}${ext}`));
  }
  return candidates;
}

function pathExts(): string[] {
  return (process.env.PATHEXT ?? '')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}

/** Default zcode CLI location: the ZCode desktop install's node bundle. */
function defaultZcodeBinary(): string {
  const candidate = join(
    homedir(),
    'AppData',
    'Local',
    'Programs',
    'ZCode',
    'resources',
    'glm',
    'zcode.cjs',
  );
  return existsSync(candidate) ? candidate : 'zcode';
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const candidates: Array<{ kind: AgentKind; command: string }> = [
    { kind: 'claude', command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude' },
    { kind: 'codex', command: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
    { kind: 'zcode', command: process.env.LARK_CHANNEL_ZCODE_BIN ?? defaultZcodeBinary() },
  ];
  const detected: DetectedAgent[] = [];
  for (const candidate of candidates) {
    try {
      detected.push({
        kind: candidate.kind,
        binaryPath: await resolveExecutablePath(candidate.command),
      });
    } catch {
      // Missing agents are reported by the caller based on the final count.
    }
  }
  return detected;
}
