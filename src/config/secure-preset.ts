import type { ProfileConfig } from './profile-schema';

/**
 * One-shot secure deployment preset (see docs/permissions.md). Stamps a
 * profile with the complete permission scheme so a fresh deployment does not
 * have to click through every console toggle:
 *
 *  - default & max access = read-only (elevate per user via /grant later)
 *  - per-user memory on (memory_write protocol + onboarding guidance)
 *  - process messages = concise (also forced at runtime for read-only users)
 *  - filesystem whitelist on (MCP path validation + native-tool/subagent
 *    denial; engine hardening runs automatically on the next agent run)
 */
export interface SecurePresetOptions {
  /** Whitelist directories; defaults to the profile's workspace. */
  dirs?: string[];
}

export function applySecurePreset(
  profile: ProfileConfig,
  opts: SecurePresetOptions = {},
): ProfileConfig {
  const dirs = (opts.dirs?.length ? opts.dirs : profile.workspaces.default ? [profile.workspaces.default] : [])
    .map((d) => d.trim())
    .filter(Boolean);
  return {
    ...profile,
    permissions: {
      ...profile.permissions,
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
      userAccess: {},
      adminAccess: undefined,
    },
    memory: { ...profile.memory, enabled: true },
    preferences: {
      ...profile.preferences,
      cotMessages: 'concise',
    },
    fsWhitelist: dirs.length > 0 ? { enabled: true, dirs } : { enabled: true },
  };
}
