import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatRootConfig, loadRootConfig } from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('root config serialization round-trip', () => {
  it('preserves zcode / memory / sessionScope through save→load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roundtrip-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');

    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app: { id: 'cli_t', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    profile.memory = { enabled: true };
    profile.sessionScope = 'chat+user';
    profile.zcode = { transport: 'cli', desktopSync: false };

    writeFileSync(
      path,
      formatRootConfig({
        schemaVersion: 2,
        activeProfile: 'p',
        preferences: {},
        profiles: { p: profile },
      }),
      'utf8',
    );

    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      profiles: { p: Record<string, unknown> };
    };
    expect(raw.profiles.p.memory).toEqual({ enabled: true });
    expect(raw.profiles.p.sessionScope).toBe('chat+user');
    expect(raw.profiles.p.zcode).toEqual({ transport: 'cli', desktopSync: false });

    const loaded = (await loadRootConfig(path))?.profiles.p;
    expect(loaded?.memory).toEqual({ enabled: true });
    expect(loaded?.sessionScope).toBe('chat+user');
    expect(loaded?.zcode).toEqual({ transport: 'cli', desktopSync: false });
  });
});
