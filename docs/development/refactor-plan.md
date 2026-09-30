# 结构重构计划

> 进度见 [progress.md](progress.md)，决策记录见 [decisions.md](decisions.md)。

## 1. 为什么重构

功能和可靠性已经比较完整（650 个测试），但结构上有三个问题在拖慢后续开发：

| 问题 | 现状（`npm run metrics`） | 后果 |
|---|---|---|
| 扩展入口是一个巨型闭包 | `src/index.ts` 2267 行；一个函数里有 33 个闭包状态、50 个内部函数 | 卡片鉴权、管理员免审、命令权限、开通审批都在这里，**没有直接测试**，只能靠真人在飞书里点 |
| 会话管理器拆分不彻底 | `conversation-manager.ts` 1590 行，其中 16 个方法只是转发给 `ConversationCommands` | 新增命令要改两处；读代码要多跳一层 |
| 配置结构维护在四处 | 类型、默认值、字段表、手写校验各一份 | 加字段漏改一处，编译器不报错 |

性能**不在**本次范围：状态文件都是 KB 级，瓶颈在模型和飞书接口，详见 §9。

## 2. 原则

1. **每一项都可观测**：有明确的信号证明它生效了。信号可以是日志事件、`status.json` 字段、`/feishu doctor` 检查项，或者 `npm run metrics` 的指标。
2. **每一项都可单独测试**：有一条命令只验证这一项，不依赖其它项。
3. **一项一个提交**（功能迁移一个功能一个提交），每个提交都能单独通过 `npm run check`。规范见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。
4. **行为不变**：除非条目明确写了行为变化，重构前后的日志事件名、`status.json` 字段、命令输出都保持不变。
5. **先锁定行为，再改结构**：拆 `index.ts` 之前，先用测试把它的现有行为锁住。

## 3. 总览

| 阶段 | 内容 | 条目 |
|---|---|---|
| A | 基线整理 | A1 内部编号清理、A2 提交与注释约定 |
| B | 可观测性基线 | B1 结构指标、B2 已启用能力清单 |
| C | 会话管理器收尾 | C1 删除转发方法 |
| D | 拆分扩展入口 | D0 行为锁定测试、D1–D6 逐块拆出、D7 网关扩展按路径识别 |
| E | 配置单一来源 | E1 zod schema |
| F | 运行时标识更名 | F1 配置目录与环境变量更名（带自动迁移） |
| G | 公开文档 | G1 文档骨架、G2 配置参考、G3 审批链路、G4 隔离 e2e 脚本 |

依赖关系：B → C → D0 → D1 → {D2, D3, D4} → D5 → D6；D7、E1、F1、G2–G4 相互独立，可以穿插。

---

## 4. 阶段 A：基线整理

### A1 内部编号清理

源码和测试里有数百处 `P1-03`、`E-09` 这类指向内部计划文档的编号，且同一编号在不同文档中含义不同。

- **改动**：测试名换成功能名前缀；注释删掉编号，只留说明；「修复的缺陷：旧实现……」改写成「必须避免什么、为什么」。
- **可观测**：`npm run metrics` 的 `internal_id_refs` 为 0。
- **单独测试**：`grep -rnE '\b[A-HP][0-9]?-[0-9]{2}\b' src tests` 无输出。
- **验收**：`npm run check` 全绿；diff 只涉及注释、测试名和断言提示文字。

### A2 提交与注释约定

- **改动**：新增 `CONTRIBUTING.md`。
- **可观测 / 单独测试**：不适用（纯文档）。

## 5. 阶段 B：可观测性基线

先把「怎么观测」建起来，后面每一项才有数可查。

### B1 结构指标

- **改动**：`scripts/metrics.mjs` + `npm run metrics`。统计 index.ts 行数、闭包状态、内部函数、转发方法、测试数、内部编号残留、最大文件。
- **可观测**：命令输出本身；`progress.md` 每项记录改前和改后的数字。
- **单独测试**：`npm run metrics -- --json` 输出合法 JSON，且 `tests` 与 `npm test` 报告的用例数一致。

### B2 已启用能力清单

默认关闭的能力有 13 项：11 项可选能力，加上流式卡片、PS 父会话转发两个实验开关。目前「线上到底开了哪些」只能去翻配置文件，人工翻很容易漏看。

- **改动**：新增 `src/features/switches.ts`，登记 13 个开关及其生效条件（与实际生效条件一致：例如 STT 必须同时有 endpoint，PS 转发必须已让权给 pi-permission-system）；`enabledFeatures(config)` 的结果写进启动日志、`status.json` 和 `/feishu doctor`。
- **可观测**：
  - 日志：`feishu.bridge.features { enabled: [...] }`（在 `bridge started` 之前一行）
  - `status.json`：`features: string[]`
  - `/feishu doctor`：新增 `features` 项，列出已启用能力
- **单独测试**：`npx tsx --test tests/features.test.ts`（默认配置返回空数组；逐项打开时只多出该项）。
- **验收**：默认配置下 `features` 为 `[]`；其它 doctor 项输出不变。

## 6. 阶段 C：会话管理器收尾

### C1 删除 16 个转发方法

- **改动**：`ConversationManager.commands` 改为公开只读字段；调用方改成 `manager.commands.xxx()`；删除转发方法。
- **可观测**：`manager_forwarders` 16 → 0；`manager_lines` 下降约 40。
- **单独测试**：`npx tsx --test tests/session-browse-resume.test.ts tests/workspace-switch.test.ts tests/model-thinking-commands.test.ts`（覆盖全部被转发的方法）。
- **验收**：纯机械替换，无行为变化。

## 7. 阶段 D：拆分扩展入口

### 目标结构

```
src/
  index.ts                  只负责：读配置、创建 BridgeRuntime、向 pi 注册命令与事件（目标 < 300 行）
  runtime/bridge-runtime.ts 原闭包状态收拢成一个对象
  runtime/lifecycle.ts      装配 / 启动 / 停止 / 心跳 / 断线补收
  commands/dispatch.ts      命令查表分发 + 未知命令提示
  commands/handlers/*.ts    按组拆分的命令处理
  interaction/card-router.ts 卡片回调：去重 → 按 op 查表 → 鉴权 → 处理
  approval/gate.ts          工具审批闸门（管理员免审、策略引擎让权）
  approval/ps-forwarding-sync.ts PS 父会话转发的环境与服务同步
  features/*.ts             11 个可选能力，每个一个模块
```

### D0 行为锁定测试（前置条件）

**这一项没完成，不开始 D1。**

- **改动**：新增 `tests/integration/extension-entry.test.ts`，用假 pi + 飞书假服务（`tests/integration/fake-feishu.ts`）从扩展入口驱动，覆盖：
  1. 卡片点击鉴权：发起人 / 管理员 / 其他人 / 重复 token / 跨群
  2. 工具审批闸门：管理员免审、策略引擎让权给 pi-permission-system、无路由放行
  3. 命令权限：`/feishu policy`、`/feishu always`、`/feishu workspace`、`/model -g`、`/cron` 的管理员判定
  4. 开通审批：只有有权限的人能点「放行此群」
- **可观测**：新测试文件的用例数（写进 progress）。
- **单独测试**：`npx tsx --test tests/integration/extension-entry.test.ts`。
- **验收**：在**未改动的** `index.ts` 上全绿。

### D1 BridgeRuntime

- **改动**：33 个闭包状态搬进 `BridgeRuntime` 对象，内部函数改为读 `rt.xxx`。**保持原有的装配顺序和 `?.` 语义**。
- **可观测**：`index_closure_state` 33 → ≤ 3。
- **单独测试**：`npx tsx --test tests/integration/extension-entry.test.ts tests/bridge-runtime.test.ts`。
- **验收**：D0 全绿；日志事件名不变。

### D2 卡片回调路由

- **改动**：`handleCardAction` 与 `handleAgentCardClick` 拆到 `interaction/card-router.ts`，op → handler 查表。两个模块注册同一个 op 时**启动即报错**。
- **可观测**：
  - 日志 `feishu.card.action`、`feishu.card.unauthorized`、`feishu.card.duplicate_token` 不变
  - 新增启动错误 `feishu.card.op_conflict { op, owners }`
- **单独测试**：`npx tsx --test tests/card-router.test.ts`（鉴权矩阵 + op 冲突）。
- **验收**：D0 的卡片用例全绿。

### D3 工具审批闸门

- **改动**：`gateToolCall` 拆到 `approval/gate.ts`；PS 转发的环境变量与服务同步拆到 `approval/ps-forwarding-sync.ts`。
- **可观测**：日志 `feishu.approval.admin_skip`、`feishu.approval.policy_engine_unavailable`、`feishu.approval.ps_forwarding_started` 不变。
- **单独测试**：`npx tsx --test tests/approval-gate.test.ts tests/ps-forwarding.test.ts`；再用 G4 的隔离 e2e 脚本跑一次完整转发链路。
- **验收**：D0 的闸门用例全绿；真实环境走一次审批卡点击（见 [operations.md](../operations.md) §审批链路验证）。

### D4 命令分发

- **改动**：`handleFeishuCommand` 里的 35 个 `case` 按组拆到 `commands/handlers/`，由 `commands/dispatch.ts` 按注册表查表分发。
- **可观测**：日志 `feishu.command { command, operator }` 不变；`index_inner_functions` 下降。
- **单独测试**：`npx tsx --test tests/command-dispatch.test.ts`（每组 handler 用假 runtime 单测）。
- **验收**：`/help` 卡片、未知命令提示、全部命令的管理员判定与 D0 一致。

### D5 可选能力插件化（11 项，一项一个提交）

```ts
export interface BridgeFeature {
	readonly name: string;
	enabled(config: BridgeConfig): boolean;
	setup(rt: BridgeRuntime): FeatureHooks | Promise<FeatureHooks>;
}
export interface FeatureHooks {
	commands?: Record<string, CommandHandler>;
	cardOps?: Record<string, CardOpHandler>;
	onLifecycleEvent?(event: LifecycleEvent): Promise<void>;
	childTools?: ChildToolFactory[];
	status?(): Record<string, unknown>;
	stop?(): Promise<void> | void;
}
```

约束：
- `enabled()` 为 false 时不创建任何对象、不注册任何东西，关闭时的行为和现在完全一致。
- 能力之间不互相 import，只通过 `BridgeRuntime` 通信。
- B2 的 `enabledFeatures()` 改为从 `FEATURES` 列表派生。

| 条目 | 能力 | 配置开关 |
|---|---|---|
| D5.1 | 定时任务 | `cron.enabled` |
| D5.2 | 桥自身告警 | `alerts.enabled` |
| D5.3 | 语音转写 | `stt.provider` |
| D5.4 | 云文档评论 | `docComments.enabled` |
| D5.5 | 会议邀请 | `meetingInvite.enabled` |
| D5.6 | agent 自定义卡片 | `cardTool.enabled` |
| D5.7 | 云文档读取工具 | `docTools.enabled` |
| D5.8 | 管理员直接执行命令 | `directBash.enabled` |
| D5.9 | 超长回答转文件 | `longReply.asFile` |
| D5.10 | 会话归档 | `retention.sessionDays` |
| D5.11 | 群开通申请 | `onboarding.accessRequest` |

每一项：
- **可观测**：打开开关后，`status.json` 的 `features` 和 `feishu.bridge.features` 日志里出现该项；关闭时不出现，也不产生该能力的任何日志。
- **单独测试**：`npx tsx --test tests/features/<name>.test.ts`，开、关两种配置各测一次。
- **验收**：默认配置下 `/feishu doctor` 输出与迁移前逐字相同。

### D6 生命周期

- **改动**：`assemble`、`start` / `stop`、心跳、断线补收拆到 `runtime/lifecycle.ts`。
- **可观测**：`index_lines` < 300；日志 `bridge started`；`status.json` 每 30 秒刷新（mtime）。
- **单独测试**：`npx tsx --test tests/lifecycle.test.ts`（启动顺序、重复 start/stop、SIGTERM 退出预算）。
- **验收**：D0 全绿；真实环境重启后 90 秒内 `status.json` mtime 在刷新。

### D7 网关扩展按路径识别

子会话需要从扩展列表里剔除桥自身，否则每个子会话都会再启动一个飞书长连接。现在的做法是按路径中的名字子串识别，改名或换安装目录就会失效。

- **改动**：改为按桥自身入口文件所在的包根目录识别（`import.meta.url`），名字列表只作为兜底。
- **可观测**：日志 `feishu.session.resource_loader_ready` 增加 `strippedGateways` 字段（正常为 1）。
- **单独测试**：`npx tsx --test tests/pi-bridge-hooks.test.ts`（任意目录名都能识别；其它扩展不误伤）。
- **验收**：真实环境里 `strippedGateways` 为 1，且只有一个 `feishu.transport.ws_ready`。

## 8. 阶段 E / F / G

### E1 配置单一来源（zod）

- **改动**：`config/schema.ts` 改为一份 zod schema，由它推导 `BridgeConfig` 类型、默认值和未知字段检测；`loadConfig` 只负责读文件、叠加环境变量、解析、格式化错误。
- **可观测**：`/feishu doctor` 的 `config_fields` 项输出不变；配置非法时的报错带完整字段路径。
- **单独测试**：`npx tsx --test tests/config.test.ts tests/config-schema.test.ts`，外加一个快照测试：`config.example.json` 与一份完整样例配置的解析结果，逐字段与迁移前一致。
- **验收**：配置向后兼容，没有任何字段的含义变化。

### F1 运行时标识更名（待确认，见 [decisions.md](decisions.md) ADR-6）

- **改动**：配置目录 `feishu-bridge/` → `feishu-channel/`，环境变量 `FEISHU_BRIDGE_*` → `FEISHU_CHANNEL_*`，日志前缀同步更名。启动时如果新目录不存在、旧目录存在，自动迁移。旧环境变量继续识别一个版本，并给出告警。
- **可观测**：迁移时记录日志 `feishu.config.migrated { from, to }`；使用旧环境变量时记录 `feishu.config.deprecated_env { name }`。
- **单独测试**：`npx tsx --test tests/runtime-identity.test.ts`（仅有旧目录 / 仅有新目录 / 两者都有 / 旧环境变量）。

### G1–G4 公开文档

| 条目 | 内容 | 单独验证 |
|---|---|---|
| G1 | 文档骨架：索引、架构、运维与排障、测试 | 链接检查：`node scripts/check-links.mjs` |
| G2 | 配置参考（从 README 拆出，按字段列出类型、默认值、含义） | E1 之后由 schema 生成，和 schema 对比无差异 |
| G3 | 审批链路：内置策略、pi-permission-system 让权、父会话转发 | 文中命令逐条可执行 |
| G4 | 不需要凭据的 PS 转发隔离 e2e 脚本（`scripts/e2e/`） | 脚本本身就是测试 |

## 9. 不做的事

- **性能优化**：状态文件（outbox、去重、pending、会话指针）都在 KB 级，内存约 70 MiB，CPU 接近 0。重新评估的触发条件：outbox 或 pending 文件超过 1 MB，或单实例承载超过 50 个活跃群。到那时优先把 outbox 改成追加日志，做法和去重存储一样。
- **删除功能**：11 项可选能力全部保留，只改装配方式。
- **一次性大改**：D 阶段严格按 D0 → D6 的顺序推进，每步都要可以单独回退。
