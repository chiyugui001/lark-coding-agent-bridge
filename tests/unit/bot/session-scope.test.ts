import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { normalizeProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';

function profileWith(sessionScope: 'chat' | 'chat+user'): ProfileConfig {
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_t', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  return normalizeProfileConfig({
    ...base,
    sessionScope,
  });
}

describe('sessionScope config', () => {
  it('defaults to chat (current behavior)', () => {
    expect(profileWith(undefined as never).sessionScope).toBe('chat');
  });

  it('accepts chat+user and round-trips', () => {
    expect(profileWith('chat+user').sessionScope).toBe('chat+user');
  });

  it('rejects unknown values back to chat', () => {
    const base = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_t', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    const cfg = normalizeProfileConfig({ ...base, sessionScope: 'bogus' as never });
    expect(cfg.sessionScope).toBe('chat');
  });
});
