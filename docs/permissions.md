# 权限控制完整方案

> 适用版本：v0.8.x。本文档描述 lark-channel-bridge 的完整权限体系：用户准入、管理权、
> agent 执行权、目录白名单、过程消息脱敏，以及各层的配置入口。

## 总览：两轴权限模型

权限分两个**正交**的轴，互不隐含：

| 轴 | 控制什么 | 配置位置 |
|---|---|---|
| **管理权** | 谁能用 bot、谁能执行管理命令（/grant /config /stop 等） | `access.allowedUsers / admins / allowedChats` |
| **执行权** | agent 本身能做什么（读写文件、执行命令的范围） | `permissions.*` + `fsWhitelist` |

owner（bot 创建者）天然拥有全部管理命令；admin 只是"管理身份"，
**不自动获得执行权**——两轴之间的桥梁是显式可配的 `adminAccess`。

## 一、用户准入与管理权

解析顺序（命中即止）：

1. owner（`botOwnerId === senderId`）→ 放行
2. team 模式（`mode: "team"`）→ 任何人可用，管理命令仍限 owner/admin
3. `allowedUsers` / `allowedChats` 白名单命中 → 放行
4. `admins` 成员 → 放行
5. 否则拒绝

管理命令（/account /config /ps /exit /reconnect /doctor /cd /ws /invite
/remove /meeting /grant）统一走 `canRunAdminCommand` 门禁。

## 二、执行权：按用户解析

```
实际执行权 = permissions.userAccess[<open_id>]     ← 显式覆盖，最高优先（对 owner 也生效）
           ?? owner → maxAccess                   ← owner 默认拿上限
           ?? admins 成员 → adminAccess ?? defaultAccess
           ?? defaultAccess                        ← 其他所有人
最终一律被 maxAccess 封顶
```

- **不写任何新配置 = 行为与传统版本一致**（adminAccess 缺省等于 defaultAccess）
- 非法组合（默认档/管理员档/用户覆盖超过 maxAccess）在配置加载与控制台保存两处校验拒绝
- 会话目录键包含解析后的实际档位（policy fingerprint），不同权限用户不共享会话

### 映射到各 agent

| 解析档位 | Claude | ZCode | Codex |
|---|---|---|---|
| read-only | plan | plan | read-only sandbox |
| workspace | acceptEdits | edit | workspace-write |
| full | bypassPermissions | yolo | danger-full-access |

只读（plan）模式下的行为约束（zcode）：
- 明确需要写入/执行的请求在**理解阶段立即止损**——第一句声明只读、
  不做任何工具调用、直接结束（查询类请求照常只读探索）；
- plan 模式的计划正文（ExitPlanMode 的 input.plan）透出为回复正文，
  不会被截断在工具调用里。

## 三、目录白名单（fsWhitelist，严格模式）

桥接层能力，**与 agent 类型无关**，参考
`@modelcontextprotocol/server-filesystem` 的双层机制：

```
fsWhitelist: { enabled: boolean, dirs?: string[] }   # dirs 缺省用默认工作目录
```

### 机制

1. **挂载路径校验的 MCP 服务器**（`lark-fs`）——官方 server-filesystem，
   白名单目录作启动参数；每个文件操作过校验链：
   realpath 展开 → 包含检查 → **软链接防逃逸**（realpath 后二次校验）→
   写新文件校验父目录链；
2. **禁用原生旁路工具**——Read/Grep/Glob/Edit/Write/Bash。不禁则
   `ls <任意路径>` 直接绕过白名单；
3. **禁用子代理**——子代理（Explore/general-purpose）有独立工具表，
   不继承主会话的禁用配置，是已知旁路；开启白名单时引擎级关闭
   `features.subagent`，claude 侧禁用 Task 工具。

### 各 agent 落地

| Agent | 机制 |
|---|---|
| ZCode | 写引擎配置（~/.zcode/cli/config.json 挂 lark-fs + disallowedTools + features.subagent=false）；配置变更自动重启 app-server 并**强制新会话**（zcode 会话在创建时固化工具集，resume 不重新套用 allow/deny） |
| Claude | 每轮运行注入 `--mcp-config` 临时文件 + `--disallowedTools`（含 Task） |
| Codex | 预留（其 sandbox 体系不同） |

### 代价与边界

- **Bash 被禁**：git/编译/命令执行均不可用，agent 变成白名单内纯文件
  操作 + 问答。需要跑构建时关闭开关，下一轮恢复；
- `search_files` 仅按**文件名**匹配，无内容 grep——agent 靠目录树 +
  读文件补偿（实测代码查询可完成，工具调用数略增）；
- 白名单目录在引擎进程启动时定格；桥接在配置变更时自动重启引擎；
- 已存在的聊天会话需 `/new` 一次才能拿到新工具集（工具集随会话固化）。

## 四、过程消息脱敏（COT 与权限联动）

过程消息五档：`off / minimal / concise / brief / detailed`。

- **只读用户强制 concise**（无视全局配置；off 仍可关闭）：
  - 思考：每段仅一句结论（元指令句过滤、中文优先、200 字上限）
  - 工具：仅显示工具名，参数/路径/输出不出
  - 中间正文：隐藏
- 有写权限用户按全局配置（brief 显示完整思考 + 工具摘要标题；
  detailed 全量）；
- 防泄露回归测试：concise 下断言绝对路径、思考原文、工具输出均不出现。

## 五、记忆系统与权限

- 每用户独立记忆文件（`<profileDir>/memory/<open_id>.md`），注入为
  `<user_memory>` 块，仅本人可见；
- **写回协议（memory_write）**：用户要求记忆时 agent 在回复末尾输出
  `<memory_write>润色后条目</memory_write>`，桥接代写文件——**只读
  用户也能用**（写文件的是桥接，不是 agent）；单轮内去重，写入串行化；
- 只读止损规则对记忆保存有**例外**：保存记忆不算写操作，不得拒绝；
- 记忆为空时首轮对话执行**初始化引导**（角色/回复风格/技术栈/偏好），
  记忆非空自动退出。

## 六、配置入口一览

| 入口 | 能改什么 |
|---|---|
| 飞书 `/grant <open_id\|me> <read-only\|workspace\|full\|reset>` | 按用户覆盖（admin） |
| 飞书 `/status` | 查看自己当前档位与来源 |
| Web 控制台「权限与隔离」 | 默认权限/上限/管理员档/用户覆盖表/记忆开关/会话隔离/目录白名单/默认工作目录/ZCode 传输与桌面同步 |
| 配置文件 `~/.lark-channel/config.json` | 全部字段（v2 schema，保存经白名单序列化，见下） |

### 序列化安全

`saveRootConfig` 按 `StoredProfileConfig` 字段白名单序列化——**新增
profile 字段必须同步加入白名单与序列化器**，否则任何保存都会静默剥掉
该字段（曾导致 zcode/memory/sessionScope/fsWhitelist 反复"丢失"）。
round-trip 回归测试（tests/unit/config/root-config-roundtrip.test.ts）
覆盖全部新字段。

## 七、已知边界（诚实清单）

1. **目录白名单关闭时，读取不受路径限制**——ZCode/Claude 引擎无路径
   沙箱，agent 可读任意可读路径；这是开启 fsWhitelist 的理由；
2. 白名单开启时牺牲 shell 能力（Bash/git/编译）——能力与隔离的权衡，
   由开关交给用户；
3. `/cd` 切到白名单外的目录时，MCP 工具无法访问新目录（需把目录加进
   dirs 或关闭白名单）；
4. 权限变更即时生效于新一轮对话；zcode 会话工具集固化，权限/白名单
   变更自动开新会话（历史上下文丢失）；
5. 桌面控制插件（computer-use/browser-use）在 CLI 侧默认禁用 +
  disallowedTools 兜底，桌面版 GUI 不受影响。
