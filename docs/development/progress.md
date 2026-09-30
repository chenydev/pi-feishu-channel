# 重构进度

> 计划见 [refactor-plan.md](refactor-plan.md)。每完成一项更新本表：状态、提交、`npm run metrics` 的相关指标、单独测试的结果。

状态：⬜ 未开始 · 🔄 进行中 · ✅ 完成 · ⏸ 待定

## 指标趋势

| 指标 | 基线 | 当前 | 目标 |
|---|---|---|---|
| `index_lines` | 2267 | 236 | < 300 |
| `index_closure_state` | 33 | 0 | ≤ 3 |
| `index_inner_functions` | 50 | 2 | ≤ 5 |
| `manager_forwarders` | 16 | 0 | 0 |
| `manager_lines` | 1590 | 1522 | 只减不增 |
| `internal_id_refs` | 0 | 0 | 0 |
| `tests` | 650 | 734 | 只增不减 |

## 条目

| 条目 | 内容 | 状态 | 提交 | 可观测信号 | 单独测试 | 结果 |
|---|---|---|---|---|---|---|
| A1 | 内部编号清理 | ✅ | — | `internal_id_refs` = 0 | `grep -rnE '\b[A-HP][0-9]?-[0-9]{2}\b' src tests` | 无输出 |
| A2 | 提交与注释约定 | ✅ | — | — | — | — |
| A3 | 去掉黑话 | ✅ | `9673bd6` | 对照词 `grep` 无输出 | 见 refactor-plan A3 的 grep 命令 | 66 个文件；doctor 与准入提示文案同步改写 |
| B1 | 结构指标 | ✅ | `3261ffe` | `npm run metrics` | `npm run metrics -- --json` | 合法 JSON；`tests` = 650，与 `npm test` 一致 |
| B2 | 已启用能力清单 | ✅ | `1e56fae` | 日志 `feishu.bridge.features`；`status.json.features`；doctor `features` | `npx tsx --test tests/features.test.ts` | 4 例通过；用生产配置离线核对得到 `accessRequest、streamingCard、psForwarding`（此前人工翻配置漏看了 psForwarding） |
| C1 | 删除转发方法 | ✅ | `f4ac6a4` | `manager_forwarders` 16 → 0 | `npx tsx --test tests/session-browse-resume.test.ts tests/workspace-switch.test.ts tests/model-thinking-commands.test.ts` | 20 例通过；`manager_lines` 1590 → 1510；80 处调用点改为 `.commands.xxx()` |
| D0 | 行为锁定测试 | ✅ | `d9be39f` | 新增 14 例 | `npx tsx --test tests/integration/extension-entry.test.ts` | 14 例通过；入口新增可选注入 `BridgeDeps.larkSdk` / `sessionBackend`（生产不传）；发现命令分级失效的缺陷，见 D0-fix |
| D0-fix | 命令分级改用原始命令 | ✅ | `76820be` | `feishu.approval.command_allow` / `command_deny` 重新出现 | `npx tsx --test --test-name-pattern '危险命令\|只读命令\|完整原始命令\|原始 bash' tests/integration/extension-entry.test.ts tests/pi-bridge-hooks.test.ts` | 4 例通过（修复前危险命令卡在等待审批）；只影响 `policyEngine` 为 bridge 的部署 |
| D1 | BridgeRuntime | ✅ | `80e76a4` | `index_closure_state` → ≤ 3 | D0 + `tests/bridge-runtime.test.ts` | 34 个闭包状态（含 `accessRequests`）集中到 `src/runtime/bridge-runtime.ts`，用 TypeScript 语言服务按引用改写为 `rt.xxx`；D0 14 例 + 新增 2 例通过；日志事件名未变 |
| D2 | 卡片回调路由 | ✅ | `66a64c2` | `feishu.card.*` 不变；`feishu.card.op_conflict` | `tests/card-router.test.ts` | 路由（查表、token 去重、会话类授权、op 冲突检测）在 `interaction/card-router.ts`；核心按钮在 `interaction/card-ops.ts`；群开通与 agent 卡片的按钮暂在入口登记，随 D5.11 / D5.6 移走；新增 5 例 + D0 卡片用例通过 |
| D3 | 工具审批检查 | 🔄 | `81c300a` | `feishu.approval.*` 不变 | `tests/approval-gate.test.ts` + G4 | 审批检查拆到 `approval/gate.ts`，PS 转发起停拆到 `approval/ps-forwarding-sync.ts`，PS 位置与安装检测拆到 `approval/pi-permission-system.ts`，日志器拆到 `runtime/logger.ts`；新增 9 例 + D0 审批用例通过；G4 隔离 e2e 与真实环境点击待 G4 / 部署切换时补 |
| D4 | 命令分发 | ✅ | `f67ed7e` | `feishu.command` 不变 | `tests/command-dispatch.test.ts` | 分发器在 `commands/dispatch.ts`（注册表外的命令名与重复登记启动即报错，日志 `feishu.command.handler_conflict`）；处理函数按组拆到 `commands/handlers/{info,admin,session,model}.ts`；`/cron` 与 `!<命令>` 暂在入口登记，随 D5.1 / D5.8 移走；新增 11 例 + D0 命令用例通过 |
| D5.1 | 定时任务 | ✅ | `7bd4e0b` | `features` 含 `cron` | `tests/features/cron.test.ts` | 新增插件框架 `features/feature.ts`（`BridgeFeature` / `FeatureHost`，命令与按钮随启动登记、停止注销）；定时任务迁到 `features/cron.ts`，`BridgeRuntime.cronScheduler` 删除；关闭时 `/cron` 仍回复「未启用」；开、关各 1 例 + 框架 3 例通过 |
| D5.2 | 桥自身告警 | ✅ | `84809c8` | `features` 含 `alerts` | `tests/features/alerts.test.ts` | 迁到 `features/alerts.ts`，框架新增 `onHeartbeat` 挂接点；`BridgeRuntime.alertMonitor` 删除（告警冷却状态改为随桥重启重置）；开、关各 1 例通过 |
| D5.3 | 语音转写 | ✅ | `16acbbe` | `features` 含 `stt` | `tests/features/stt.test.ts` | 迁到 `features/stt.ts`，框架新增 `transcribe` 挂接点，资源下载器从 `featureHost.first("transcribe")` 取转写器；开、关与 features 列表共 3 例通过 |
| D5.4 | 云文档评论 | ✅ | `afe2d57` | `features` 含 `docComments` | `tests/features/doc-comments.test.ts` | 迁到 `features/doc-comments.ts`（事件去重改用 `features/first-seen.ts`）；生命周期事件先走核心处理再分发给各能力；测试装置新增 `h.event()` 投递平台事件；开、关各 1 例通过 |
| D5.5 | 会议邀请 | ✅ | `b5609ec` | `features` 含 `meetingInvite` | `tests/features/meeting-invite.test.ts` | 迁到 `features/meeting-invite.ts`；开、关各 1 例通过 |
| D5.6 | agent 自定义卡片 | ✅ | `bfc67ef` | `features` 含 `cardTool` | `tests/features/card-tool.test.ts` | 迁到 `features/card-tool.ts`，框架新增 `sendCard` 挂接点，子会话按是否提供该挂接点决定注册工具；签名密钥改为每次启动生成；开 2 例、关 1 例通过 |
| D5.7 | 云文档读取工具 | ✅ | `672c0fc` | `features` 含 `docTools` | `tests/features/doc-tools.test.ts` | 迁到 `features/doc-tools.ts`，框架新增 `readDoc` 挂接点；开、关各 1 例通过 |
| D5.8 | 直接执行命令 | ✅ | `07553bb` | `features` 含 `directBash` | `tests/features/direct-bash.test.ts` | 迁到 `features/direct-bash.ts`，用 `commandInterceptor` 挂接点；开、关各 1 例通过 |
| D5.9 | 超长回答转文件 | ✅ | `2dcc88e` | `features` 含 `longReply` | `tests/features/long-reply.test.ts` | 逻辑从 `session/run-executor.ts` 移到 `features/long-reply.ts`，会话层只保留 `replyAsFile` 依赖；日志 `feishu.conv.long_reply_*` 不变；开 2 例、关 1 例通过 |
| D5.10 | 会话归档 | ✅ | `cc2aa87` | `features` 含 `retention` | `tests/features/retention.test.ts` | 归档迁到 `features/retention.ts`；收紧会话文件权限仍是核心行为（每次启动都做）；`feishu.retention` 分成两条（收紧 / 归档各一条，字段不变）；开、关各 1 例通过 |
| D5.11 | 群开通申请 | ✅ | `258e8d5` | `features` 含 `accessRequest` | `tests/features/access-request.test.ts` | 迁到 `features/access-request.ts`（申请、「暂不放行」按钮）；审批人称呼、私聊管理员、群里发卡片抽到 `runtime/onboarding.ts` 供入口与插件共用；`enabledFeatures()` 改为从 `FEATURES` 派生；开、关各 1 例通过。**D5 整体验收**：默认配置下 `/feishu doctor` 输出与 `d9be39f` 逐字相同（只有临时目录名不同） |
| D6 | 生命周期 | ✅ | `1716439` | `index_lines` < 300；`bridge started`；status mtime | `tests/lifecycle.test.ts` | 拆出 `runtime/lifecycle.ts`（启停、心跳、断线补收、重连监管）、`runtime/assemble.ts`（组件装配）、`runtime/status-reporter.ts`、`runtime/app-admins.ts`、`interaction/platform-events.ts`、`commands/tui.ts`；index 236 行；新增 3 例（启动失败回滚、启停串行、重复启停）；SIGTERM 退出预算会调用 process.exit，未做自动化测试，真实环境验收时观察 `feishu.shutdown.done` |
| D7 | 网关扩展按路径识别 | ✅ |  | `resource_loader_ready.strippedGateways` = 1 | `tests/pi-bridge-hooks.test.ts` | 按包根目录（`import.meta.url` 上两级，按真实路径比较）识别桥自身，名字特征只作兜底；`resource_loader_ready` 升为 info 并带 `strippedGateways`；新增 4 例（任意目录名、前缀相同不误伤、软链接、日志字段）；真实环境核对待部署切换 |
| E1 | 配置 schema（zod） | ⬜ | | doctor `config_fields` 不变 | 配置快照测试 | |
| F1 | 运行时标识更名 | ⬜ | | `feishu.config.migrated`；`feishu.config.deprecated_env` | `tests/runtime-identity.test.ts` | ADR-6 已定：改名并自动迁移 |
| G1 | 文档骨架 | ✅ | `5f9ad2d` | — | `npm run docs:check` | 链接检查通过 |
| G2 | 配置参考 | ⬜ | | — | 与 schema 对比 | |
| G3 | 审批链路文档 | ⬜ | | — | 文中命令可执行 | |
| G4 | PS 转发隔离 e2e | ⬜ | | 脚本输出 | 脚本本身 | |

## 真实环境验收记录

D3、D6、D7 以及每批 D5 完成后，在真实部署里验收一次（步骤见 [operations.md](../operations.md) §上线验收）。

| 日期 | 条目 | 结果 | 备注 |
|---|---|---|---|
