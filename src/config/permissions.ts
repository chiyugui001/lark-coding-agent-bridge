export type AccessMode = 'read-only' | 'workspace' | 'full';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface PermissionConfig {
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
  claude?: {
    permissionMode?: ClaudePermissionMode;
  };
  /**
   * Per-user access-mode overrides keyed by Feishu open_id. Wins over every
   * other rule for that user (including the owner rule). Entries must not
   * exceed maxAccess.
   */
  userAccess?: Record<string, AccessMode>;
  /**
   * Access mode applied to members of `access.admins` without an explicit
   * `userAccess` entry. Defaults to `defaultAccess` (the pre-existing
   * behavior: being an admin never raised the agent's own permissions).
   */
  adminAccess?: AccessMode;
}

export type PermissionSource = 'permissions' | 'sandbox' | 'default';

interface LegacySandboxInput {
  default?: CodexSandboxMode;
  max?: CodexSandboxMode;
  defaultMode?: CodexSandboxMode;
  maxMode?: CodexSandboxMode;
}

export interface NormalizedPermissions {
  permissions: PermissionConfig;
  source: PermissionSource;
}

const ACCESS_ORDER: Record<AccessMode, number> = {
  'read-only': 0,
  workspace: 1,
  full: 2,
};

const CLAUDE_PERMISSION_ACCESS: Record<ClaudePermissionMode, AccessMode> = {
  plan: 'read-only',
  default: 'workspace',
  acceptEdits: 'workspace',
  bypassPermissions: 'full',
};

export function normalizePermissions(input: {
  permissions?: Partial<PermissionConfig> | undefined;
  sandbox?: Partial<LegacySandboxInput> | undefined;
}): NormalizedPermissions {
  const hasSandbox = hasLegacySandbox(input.sandbox);
  const base = hasSandbox
    ? normalizeLegacySandboxPermissions(input.sandbox)
    : defaultPermissions();

  if (input.permissions !== undefined) {
    return {
      permissions: normalizeCanonicalPermissions(input.permissions, base),
      source: 'permissions',
    };
  }

  return {
    permissions: base,
    source: hasSandbox ? 'sandbox' : 'default',
  };
}

export function assertAccessPair(
  defaultAccess: AccessMode,
  maxAccess: AccessMode,
  source: PermissionSource | 'sandbox' = 'permissions',
): void {
  if (ACCESS_ORDER[defaultAccess] > ACCESS_ORDER[maxAccess]) {
    const suffix = source === 'sandbox' ? ' from sandbox' : '';
    throw new Error(`permission defaultAccess cannot exceed maxAccess${suffix}`);
  }
}

export function clampAccess(
  defaultAccess: AccessMode,
  profileMax: AccessMode,
  capabilityMax: AccessMode,
): AccessMode {
  const maxAllowed =
    ACCESS_ORDER[profileMax] < ACCESS_ORDER[capabilityMax] ? profileMax : capabilityMax;
  return ACCESS_ORDER[defaultAccess] <= ACCESS_ORDER[maxAllowed] ? defaultAccess : maxAllowed;
}

export function codexSandboxToAccess(mode: CodexSandboxMode): AccessMode {
  switch (mode) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace';
    case 'danger-full-access':
      return 'full';
    default:
      throw new Error('invalid sandbox mode');
  }
}

export function accessToCodexSandbox(access: AccessMode): CodexSandboxMode {
  switch (access) {
    case 'read-only':
      return 'read-only';
    case 'workspace':
      return 'workspace-write';
    case 'full':
      return 'danger-full-access';
  }
}

export function accessToClaudePermissionMode(
  access: AccessMode,
  permissions?: PermissionConfig,
): ClaudePermissionMode {
  const override = permissions?.claude?.permissionMode;
  if (
    override &&
    ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[override]] <= ACCESS_ORDER[access]
  ) {
    return override;
  }

  return accessToDefaultClaudePermissionMode(access);
}

function accessToDefaultClaudePermissionMode(access: AccessMode): ClaudePermissionMode {
  switch (access) {
    case 'read-only':
      return 'plan';
    case 'workspace':
      return 'acceptEdits';
    case 'full':
      return 'bypassPermissions';
  }
}

export function permissionsToLegacySandbox(permissions: PermissionConfig): {
  default: CodexSandboxMode;
  max: CodexSandboxMode;
  defaultMode: CodexSandboxMode;
  maxMode: CodexSandboxMode;
} {
  const defaultMode = accessToCodexSandbox(permissions.defaultAccess);
  const maxMode = accessToCodexSandbox(permissions.maxAccess);
  return {
    default: defaultMode,
    max: maxMode,
    defaultMode,
    maxMode,
  };
}

function normalizeCanonicalPermissions(
  input: Partial<PermissionConfig>,
  base: PermissionConfig,
): PermissionConfig {
  if (!isConfigObject(input)) {
    throw new Error('invalid permission config');
  }

  const explicitMaxAccess = readAccess(input.maxAccess, 'maxAccess');
  const explicitDefaultAccess = readAccess(input.defaultAccess, 'defaultAccess');
  const maxAccess = explicitMaxAccess ?? base.maxAccess;
  const defaultAccess =
    explicitDefaultAccess ??
    (ACCESS_ORDER[base.defaultAccess] <= ACCESS_ORDER[maxAccess] ? base.defaultAccess : maxAccess);
  assertAccessPair(defaultAccess, maxAccess);

  const claude = normalizeClaudePermissions(input.claude);
  if (claude?.permissionMode) {
    assertClaudePermissionWithinAccess(claude.permissionMode, maxAccess);
  }
  const userAccess = normalizeUserAccess(input.userAccess, maxAccess);
  const adminAccess = readAccessWithin(input.adminAccess, 'adminAccess', maxAccess);
  return {
    defaultAccess,
    maxAccess,
    ...(claude ? { claude } : {}),
    ...(Object.keys(userAccess).length > 0 ? { userAccess } : {}),
    ...(adminAccess ? { adminAccess } : {}),
  };
}

function normalizeUserAccess(
  input: PermissionConfig['userAccess'],
  maxAccess: AccessMode,
): Record<string, AccessMode> {
  if (input === undefined) return {};
  if (!isConfigObject(input)) {
    throw new Error('invalid permission userAccess');
  }
  const out: Record<string, AccessMode> = {};
  for (const [userId, mode] of Object.entries(input)) {
    if (!userId.trim()) throw new Error('invalid permission userAccess: empty user id');
    const resolved = readAccessWithin(mode, `userAccess.${userId}`, maxAccess);
    if (!resolved) throw new Error(`invalid permission userAccess.${userId}`);
    out[userId] = resolved;
  }
  return out;
}

function readAccessWithin(
  value: unknown,
  field: string,
  maxAccess: AccessMode,
): AccessMode | undefined {
  if (value === undefined) return undefined;
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  if (ACCESS_ORDER[value] > ACCESS_ORDER[maxAccess]) {
    throw new Error(`permission ${field} cannot exceed maxAccess`);
  }
  return value;
}

export type UserAccessSource = 'userAccess' | 'owner' | 'adminAccess' | 'default';

export interface ResolvedUserAccess {
  mode: AccessMode;
  source: UserAccessSource;
}

/**
 * Resolve the effective agent access mode for one sender. Priority:
 * explicit userAccess entry > owner (profile maxAccess) > adminAccess for
 * access.admins members > defaultAccess. The result still needs the usual
 * capability clamp at policy evaluation.
 */
export function resolveUserAccessMode(input: {
  permissions: Pick<PermissionConfig, 'defaultAccess' | 'maxAccess' | 'userAccess' | 'adminAccess'>;
  admins: readonly string[];
  senderId: string;
  isOwner: boolean;
}): ResolvedUserAccess {
  const explicit = input.permissions.userAccess?.[input.senderId];
  if (explicit) return { mode: explicit, source: 'userAccess' };
  if (input.isOwner) return { mode: input.permissions.maxAccess, source: 'owner' };
  if (input.admins.includes(input.senderId)) {
    const adminMode = input.permissions.adminAccess ?? input.permissions.defaultAccess;
    return { mode: adminMode, source: input.permissions.adminAccess ? 'adminAccess' : 'default' };
  }
  return { mode: input.permissions.defaultAccess, source: 'default' };
}

function defaultPermissions(): PermissionConfig {
  return {
    defaultAccess: 'full',
    maxAccess: 'full',
  };
}

function assertClaudePermissionWithinAccess(
  permissionMode: ClaudePermissionMode,
  maxAccess: AccessMode,
): void {
  if (ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[permissionMode]] > ACCESS_ORDER[maxAccess]) {
    throw new Error('permission claude.permissionMode cannot exceed maxAccess');
  }
}

function normalizeLegacySandboxPermissions(
  input: Partial<LegacySandboxInput> | undefined,
): PermissionConfig {
  if (!isConfigObject(input)) {
    throw new Error('invalid sandbox mode');
  }

  const maxMode = readSandboxMode(input.max ?? input.maxMode, 'maxMode') ?? 'danger-full-access';
  const defaultMode = readSandboxMode(input.default ?? input.defaultMode, 'defaultMode') ?? maxMode;
  const defaultAccess = codexSandboxToAccess(defaultMode);
  const maxAccess = codexSandboxToAccess(maxMode);
  assertAccessPair(defaultAccess, maxAccess, 'sandbox');

  return {
    defaultAccess,
    maxAccess,
  };
}

function normalizeClaudePermissions(
  input: PermissionConfig['claude'] | undefined,
): PermissionConfig['claude'] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isConfigObject(input)) {
    throw new Error('invalid permission claude config');
  }
  if (input.permissionMode === undefined) {
    return undefined;
  }
  if (!isClaudePermissionMode(input.permissionMode)) {
    throw new Error('invalid permission claude.permissionMode');
  }
  return {
    permissionMode: input.permissionMode,
  };
}

function hasLegacySandbox(input: Partial<LegacySandboxInput> | undefined): boolean {
  if (input === undefined) {
    return false;
  }
  if (!isConfigObject(input)) {
    throw new Error('invalid sandbox mode');
  }
  return (
    input.default !== undefined ||
    input.max !== undefined ||
    input.defaultMode !== undefined ||
    input.maxMode !== undefined
  );
}

function readAccess(value: unknown, field: string): AccessMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  return value;
}

function readSandboxMode(value: unknown, field: string): CodexSandboxMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isCodexSandboxMode(value)) {
    throw new Error(`invalid sandbox ${field}`);
  }
  return value;
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan'
  );
}
