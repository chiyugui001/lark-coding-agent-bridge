import { describe, expect, it } from 'vitest';
import { filterSupportOutput, SUPPORT_MODE_PROMPT } from '../../../src/bot/support-filter';
import { resolveUserAccessMode } from '../../../src/config/permissions';

describe('filterSupportOutput', () => {
  it('strips code blocks', () => {
    const { filtered, hits } = filterSupportOutput('重启方式如下：\n```c\nvoid reset(void) {\n  NVIC_SystemReset();\n}\n```\n完毕');
    expect(filtered).not.toContain('NVIC_SystemReset');
    expect(filtered).toContain('[技术细节已隐藏]');
    expect(hits).toBeGreaterThan(0);
  });

  it('strips file paths and filenames with line numbers', () => {
    const { filtered } = filterSupportOutput('参考 board_system.c:142 中的实现');
    expect(filtered).not.toContain('board_system.c');
    expect(filtered).toContain('[内部实现]');
  });

  it('strips Windows paths', () => {
    const { filtered } = filterSupportOutput('代码在 D:\\git\\iot\\sensor\\lora\\uc711\\ 下');
    expect(filtered).not.toContain('D:\\git');
    expect(filtered).toContain('[内部路径]');
  });

  it('strips hex register values', () => {
    const { filtered } = filterSupportOutput('写入 0x8000 到寄存器');
    expect(filtered).not.toContain('0x8000');
    expect(filtered).toContain('[寄存器配置]');
  });

  it('keeps plain-language text intact', () => {
    const input = '长按设备按键 5 秒，指示灯闪烁后松开即可重启。如无响应，长按 10 秒强制重启。';
    const { filtered, hits } = filterSupportOutput(input);
    expect(filtered).toBe(input);
    expect(hits).toBe(0);
  });
});

describe('resolveUserAccessMode with rolePermissions', () => {
  const basePerms = { defaultAccess: 'read-only' as const, maxAccess: 'full' as const };
  const rolePerms = {
    '固件开发': { access: 'full' as const, responseMode: 'technical' as const },
    '售前': { access: 'read-only' as const, responseMode: 'support' as const },
  };

  it('matches role by substring (department name)', () => {
    const result = resolveUserAccessMode({
      permissions: basePerms,
      admins: [],
      senderId: 'ou_x',
      isOwner: false,
      userRole: '固件开发部',
      rolePermissions: rolePerms,
    });
    expect(result.source).toBe('role');
    expect(result.mode).toBe('full');
    expect(result.responseMode).toBe('technical');
  });

  it('matches support role and sets responseMode', () => {
    const result = resolveUserAccessMode({
      permissions: basePerms,
      admins: [],
      senderId: 'ou_y',
      isOwner: false,
      userRole: '售前部',
      rolePermissions: rolePerms,
    });
    expect(result.source).toBe('role');
    expect(result.mode).toBe('read-only');
    expect(result.responseMode).toBe('support');
  });

  it('explicit userAccess wins over role mapping', () => {
    const result = resolveUserAccessMode({
      permissions: { ...basePerms, userAccess: { 'ou_z': 'workspace' as const } },
      admins: [],
      senderId: 'ou_z',
      isOwner: false,
      userRole: '售前部',
      rolePermissions: rolePerms,
    });
    expect(result.source).toBe('userAccess');
    expect(result.mode).toBe('workspace');
  });

  it('falls back to default when role does not match', () => {
    const result = resolveUserAccessMode({
      permissions: basePerms,
      admins: [],
      senderId: 'ou_w',
      isOwner: false,
      userRole: '行政部门',
      rolePermissions: rolePerms,
    });
    expect(result.source).toBe('default');
    expect(result.mode).toBe('read-only');
    expect(result.responseMode).toBeUndefined();
  });

  it('no rolePermissions provided falls through normally', () => {
    const result = resolveUserAccessMode({
      permissions: basePerms,
      admins: [],
      senderId: 'ou_v',
      isOwner: false,
    });
    expect(result.source).toBe('default');
  });
});
