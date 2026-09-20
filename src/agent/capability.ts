import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'zcode';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'zcode-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix' | 'argv-prompt';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function zcodeCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'zcode',
    sessionKind: 'zcode-session',
    promptInjection: 'argv-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/** Resolve the capability for a profile's agent kind. */
export function agentCapability(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  if (profile.agentKind === 'codex') return codexCapability(profile);
  if (profile.agentKind === 'zcode') return zcodeCapability(profile);
  return claudeCapability(profile);
}
