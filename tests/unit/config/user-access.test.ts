import { describe, expect, it } from 'vitest';
import {
  normalizePermissions,
  resolveUserAccessMode,
  type PermissionConfig,
} from '../../../src/config/permissions';

function perms(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return { defaultAccess: 'read-only', maxAccess: 'full', ...overrides };
}

describe('resolveUserAccessMode', () => {
  const admins = ['ou_admin'];

  it('explicit userAccess wins for everyone including owner', () => {
    const r = resolveUserAccessMode({
      permissions: perms({ userAccess: { ou_owner: 'read-only', ou_admin: 'full', ou_x: 'workspace' } }),
      admins,
      senderId: 'ou_owner',
      isOwner: true,
    });
    expect(r).toEqual({ mode: 'read-only', source: 'userAccess' });
  });

  it('owner falls back to maxAccess', () => {
    const r = resolveUserAccessMode({
      permissions: perms(),
      admins,
      senderId: 'ou_owner',
      isOwner: true,
    });
    expect(r).toEqual({ mode: 'full', source: 'owner' });
  });

  it('admins get adminAccess when set, defaultAccess otherwise', () => {
    expect(
      resolveUserAccessMode({ permissions: perms({ adminAccess: 'full' }), admins, senderId: 'ou_admin', isOwner: false }),
    ).toEqual({ mode: 'full', source: 'adminAccess' });
    expect(
      resolveUserAccessMode({ permissions: perms(), admins, senderId: 'ou_admin', isOwner: false }),
    ).toEqual({ mode: 'read-only', source: 'default' });
  });

  it('regular users get defaultAccess', () => {
    expect(
      resolveUserAccessMode({ permissions: perms(), admins, senderId: 'ou_other', isOwner: false }),
    ).toEqual({ mode: 'read-only', source: 'default' });
  });
});

describe('normalizePermissions per-user fields', () => {
  it('accepts and round-trips userAccess and adminAccess within maxAccess', () => {
    const { permissions } = normalizePermissions({
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'full',
        userAccess: { ou_a: 'full', ou_b: 'read-only' },
        adminAccess: 'workspace',
      },
    });
    expect(permissions.userAccess).toEqual({ ou_a: 'full', ou_b: 'read-only' });
    expect(permissions.adminAccess).toBe('workspace');
  });

  it('rejects userAccess entries exceeding maxAccess', () => {
    expect(() =>
      normalizePermissions({
        permissions: { defaultAccess: 'read-only', maxAccess: 'read-only', userAccess: { ou_a: 'full' } },
      }),
    ).toThrow(/cannot exceed maxAccess/);
  });

  it('rejects invalid access values', () => {
    expect(() =>
      normalizePermissions({
        permissions: { defaultAccess: 'read-only', maxAccess: 'full', userAccess: { ou_a: 'root' } } as never,
      }),
    ).toThrow(/invalid permission userAccess/);
  });

  it('omits empty userAccess', () => {
    const { permissions } = normalizePermissions({
      permissions: { defaultAccess: 'workspace', maxAccess: 'full' },
    });
    expect(permissions.userAccess).toBeUndefined();
    expect(permissions.adminAccess).toBeUndefined();
  });
});
