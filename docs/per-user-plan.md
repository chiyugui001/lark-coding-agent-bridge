# 按用户权限 + 每用户记忆文件 — 实施计划

## 目标行为

**权限解析优先级**（每次运行 agent 时按发送者解析）：

```
1. permissions.userAccess[<open_id>]     ← 显式指定，最高优先（对 owner 也生效）
2. 否则 owner（bot 创建者）→ maxAccess
3. 否则 access.admins 成员 → permissions.adminAccess ?? defaultAccess
4. 否则 → permissions.defaultAccess
最终一律再被 maxAccess 封顶（不变）
```

- 不写任何新配置 = 行为与现状一致（除指纹格式变更，见"兼容性"）。
- admin（管理命令权力）与 agent 权限（读写能力）两轴解耦，`adminAccess` 是两轴间显式的桥。
- 每用户记忆：`<profileDir>/memory/<open_id>.md`，组装 prompt 时以 `<user_memory>` 块注入；
  有写权限（workspace/full）的用户 agent 可自行维护记忆文件，只读用户用 `/memory` 命令维护。

## Phase 1：按用户权限

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1.1 | `src/config/permissions.ts` | `PermissionConfig` 新增 `userAccess?: Record<string, AccessMode>`、`adminAccess?: AccessMode`；normalize 校验值合法且 ≤ maxAccess；新增 `resolveUserAccessMode(profile, senderId, isOwner)` 返回 `{ mode, source }` |
| 1.2 | `src/policy/run-policy.ts` | `evaluateRunPolicy` 用 `resolveUserAccessMode` 替换 `defaultAccess`（owner 判定复用 `AccessDecision.reason === 'owner'`） |
| 1.3 | `src/policy/fingerprint.ts` | `FingerprintInputV2` 增加 `accessMode` 字段，保证不同权限用户不共享会话目录键 |
| 1.4 | `src/commands/index.ts` | `/status` 显示当前用户档位+来源；新增 `/grant <open_id|@用户> <read-only\|workspace\|full\|reset>`（加入 ADMIN_COMMANDS）；`/config` 卡片追加 adminAccess / userAccess 概览 |
| 1.5 | tests | resolveUserAccessMode 优先级/封顶；run-policy 按人出不同 permissionMode；配置规范化；指纹区分 |

派生链路（claude permissionMode / zcode mode / codex sandbox）自动跟随新 accessMode，适配器无需改动。

## Phase 2：每用户记忆文件

| 步骤 | 文件 | 内容 |
|---|---|---|
| 2.1 | `src/bot/memory-store.ts`（新） | `MemoryStore(baseDir)`：get/append/clear/pathFor；open_id 白名单清洗；注入上限（默认 8KB 截断） |
| 2.2 | `src/config/profile-schema.ts` | `memory?: { enabled: boolean; injectMaxBytes?: number }`，默认 `enabled: false` |
| 2.3 | `src/agent/prompt.ts` + `src/bot/channel.ts` | `buildAgentPrompt` 新增 `userMemory?`，渲染 `<user_memory>` 块（bridge_context 之后）；channel 按 senderId 读取注入；档位 ≥ workspace 时块尾附记忆文件路径提示（agent 自维护），只读档不提示 |
| 2.4 | `src/commands/index.ts` | `/memory`：无参预览自己的记忆；`add <内容>` 追加；`clear` 清空 |
| 2.5 | tests | MemoryStore 读写/清洗/上限；注入与"写权限才提示路径"分支；/memory 命令 |

## Phase 3：群聊按用户隔离会话（开关，默认关闭）

| 步骤 | 文件 | 内容 |
|---|---|---|
| 3.1 | `src/config/profile-schema.ts` | `sessionScope: 'chat' \| 'chat+user'`，默认 `'chat'`（现状） |
| 3.2 | `src/bot/channel.ts` | 仅 IM 路径：sessions/catalog 的 scope key 按 `sessionScope` 取 `chatId` 或 `chatId\u001f<senderId>`；评论/会议作用域不动 |

## 兼容性说明

1. **指纹格式变更**：Phase 1 给指纹加字段后，存量会话目录键失效一次——升级后每个聊天的下一轮自动开新会话（旧会话数据不丢，仍可 /resume）。
2. **owner 行为变化**：现状 owner 跑 agent 吃全局 defaultAccess；新方案 owner 默认拿 maxAccess（可用 `userAccess[owner]=read-only` 钉死）。当前 profile maxAccess=read-only，实际不变。

## 验证矩阵

| 场景 | 预期 |
|---|---|
| 普通用户（默认档） | plan 只读，写操作被拒 |
| admin 且 adminAccess: full | yolo 可写；/grant 可用 |
| /grant 提权的普通用户 | 立即生效为 full（新一轮） |
| A /memory add 我叫张三 后问"我叫什么" | 答张三；B 看不到 |
| full 用户 agent 自维护记忆 | Edit 记忆文件成功，下轮注入生效 |
| 群聊开 chat+user 隔离 | 群里各用户上下文互不可见 |

## 提交策略

每个 Phase 完成即 typecheck + 相关测试 + commit；全部完成后更新 README（中英）、构建、重启 supervisor、跑验证矩阵，最终 push。
