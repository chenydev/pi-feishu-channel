# 重构进度

> 计划见 [refactor-plan.md](refactor-plan.md)。每完成一项更新本表：状态、提交、`npm run metrics` 的相关指标、单独测试的结果。

状态：⬜ 未开始 · 🔄 进行中 · ✅ 完成 · ⏸ 待定

## 指标趋势

| 指标 | 基线 | 当前 | 目标 |
|---|---|---|---|
| `index_lines` | 2267 | 2267 | < 300 |
| `index_closure_state` | 33 | 33 | ≤ 3 |
| `index_inner_functions` | 50 | 50 | ≤ 5 |
| `manager_forwarders` | 16 | 16 | 0 |
| `manager_lines` | 1590 | 1590 | < 1450 |
| `internal_id_refs` | 0 | 0 | 0 |
| `tests` | 650 | 650 | 只增不减 |

## 条目

| 条目 | 内容 | 状态 | 提交 | 可观测信号 | 单独测试 | 结果 |
|---|---|---|---|---|---|---|
| A1 | 内部编号清理 | ✅ | — | `internal_id_refs` = 0 | `grep -rnE '\b[A-HP][0-9]?-[0-9]{2}\b' src tests` | 无输出 |
| A2 | 提交与注释约定 | ✅ | — | — | — | — |
| B1 | 结构指标 | ✅ | | `npm run metrics` | `npm run metrics -- --json` | 合法 JSON；`tests` = 650，与 `npm test` 一致 |
| B2 | 已启用能力清单 | ⬜ | | 日志 `feishu.bridge.features`；`status.json.features`；doctor `features` | `tests/features.test.ts` | |
| C1 | 删除转发方法 | ⬜ | | `manager_forwarders` 16 → 0 | 会话浏览 / 工作区 / 模型命令三组测试 | |
| D0 | 行为锁定测试 | ⬜ | | 新增用例数 | `tests/integration/extension-entry.test.ts` | |
| D1 | BridgeRuntime | ⬜ | | `index_closure_state` → ≤ 3 | D0 + `tests/bridge-runtime.test.ts` | |
| D2 | 卡片回调路由 | ⬜ | | `feishu.card.*` 不变；`feishu.card.op_conflict` | `tests/card-router.test.ts` | |
| D3 | 工具审批闸门 | ⬜ | | `feishu.approval.*` 不变 | `tests/approval-gate.test.ts` + G4 | |
| D4 | 命令分发 | ⬜ | | `feishu.command` 不变 | `tests/command-dispatch.test.ts` | |
| D5.1 | 定时任务 | ⬜ | | `features` 含 `cron` | `tests/features/cron.test.ts` | |
| D5.2 | 桥自身告警 | ⬜ | | `features` 含 `alerts` | `tests/features/alerts.test.ts` | |
| D5.3 | 语音转写 | ⬜ | | `features` 含 `stt` | `tests/features/stt.test.ts` | |
| D5.4 | 云文档评论 | ⬜ | | `features` 含 `docComments` | `tests/features/doc-comments.test.ts` | |
| D5.5 | 会议邀请 | ⬜ | | `features` 含 `meetingInvite` | `tests/features/meeting-invite.test.ts` | |
| D5.6 | agent 自定义卡片 | ⬜ | | `features` 含 `cardTool` | `tests/features/card-tool.test.ts` | |
| D5.7 | 云文档读取工具 | ⬜ | | `features` 含 `docTools` | `tests/features/doc-tools.test.ts` | |
| D5.8 | 直接执行命令 | ⬜ | | `features` 含 `directBash` | `tests/features/direct-bash.test.ts` | |
| D5.9 | 超长回答转文件 | ⬜ | | `features` 含 `longReply` | `tests/features/long-reply.test.ts` | |
| D5.10 | 会话归档 | ⬜ | | `features` 含 `retention` | `tests/features/retention.test.ts` | |
| D5.11 | 群开通申请 | ⬜ | | `features` 含 `accessRequest` | `tests/features/access-request.test.ts` | |
| D6 | 生命周期 | ⬜ | | `index_lines` < 300；`bridge started`；status mtime | `tests/lifecycle.test.ts` | |
| D7 | 网关扩展按路径识别 | ⬜ | | `resource_loader_ready.strippedGateways` = 1 | `tests/pi-bridge-hooks.test.ts` | |
| E1 | 配置 schema（zod） | ⬜ | | doctor `config_fields` 不变 | 配置快照测试 | |
| F1 | 运行时标识更名 | ⏸ | | `feishu.config.migrated` | `tests/runtime-identity.test.ts` | 待 D6 决策 |
| G1 | 文档骨架 | ✅ | | — | `npm run docs:check` | 链接检查通过 |
| G2 | 配置参考 | ⬜ | | — | 与 schema 对比 | |
| G3 | 审批链路文档 | ⬜ | | — | 文中命令可执行 | |
| G4 | PS 转发隔离 e2e | ⬜ | | 脚本输出 | 脚本本身 | |

## 真实环境验收记录

D3、D6、D7 以及每批 D5 完成后，在真实部署里验收一次（步骤见 [operations.md](../operations.md) §上线验收）。

| 日期 | 条目 | 结果 | 备注 |
|---|---|---|---|
