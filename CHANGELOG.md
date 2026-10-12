# Changelog

本项目不打 tag 时请按 commit 钉版本（见 README「用 pi 从 git 安装」）。

## 未发布

- **破坏性变更（启动）**：只在 RPC 模式（`pi --mode rpc`）自动启动飞书桥。本地 TUI、print / json 模式装了本扩展也不再自动连飞书，
  免得和部署的实例抢同一个应用的长连接；需要时在 TUI 里 `/feishu:start` 手动启动。跳过时打日志 `feishu.bridge.autostart_skipped`（带 `mode`），
  状态栏显示「飞书桥未启动」。老版本 pi 的扩展上下文里没有运行模式，照旧自动启动。
  SIGTERM 的优雅关闭也只在自动启动时挂上，TUI 下交给 pi 自己处理（原先会抢在 pi 恢复终端之前退出进程）。
- **破坏性变更（审批）**：pi-permission-system（下称 PS）的「询问」改为经它的授权链变成审批卡，不再冒充它的父会话转发。
  - **要求 PS 27.0.0 及以上**，并在 PS 配置里写 `"authorizerChain": ["feishu-channel"]`；只设 `approval.mode: "pi-permission-system"` 不够。
  - 删除 `approval.forwarding.*`（`enabled`、`parentSessionId`）和环境变量 `FEISHU_PS_FORWARDING`；
    「始终批准」开关从 `approval.forwarding.alwaysApprove` 移到 `approval.plugin.alwaysApprove`（环境变量 `FEISHU_PS_ALWAYS` 不变），
    已记的规则（`ps-always-approved.json`）继续有效。`status.json` 的 `features` 不再有 `psForwarding`。
  - 会话里临时切到 `pi-permission-system` 也会弹卡（原先的转发只跟全局模式走）。
  - 读写工作目录以外的文件（PS 的 `path`、`external_directory` 请求）不能再在卡上批准：PS 不允许授权链放行这两类，
    需要时在 PS 配置里放行（日志 `feishu.approval.ps_link_capped`）。飞书会话里 subagent 发起的询问不弹卡。
  - bash 复合命令里有几段需要询问时，每段的规则都批准过才按「本会话批准」「始终批准」自动放行（原先只看第一段）。
  - `approval.adminSkipApproval` 在 PS 模式下也生效：管理员发起的调用不再弹卡。
  - 可观测：启动日志 `feishu.approval.ps_link`（版本、`authorizerChain`），没写上时 `ps_link_not_in_chain`，版本过低时 `ps_version_unsupported`；
    `/feishu doctor` 的 `ps_forwarding` 换成 `ps_link`；`/feishu approvals` 显示「询问」会弹卡还是被直接拒绝。
    `feishu.approval.ps_forwarding*` 系列日志删除，新增 `ps_link_decision`、`ps_always_approved`、`ps_session_approved`、`ps_always_recorded`。
  - 端到端脚本 `scripts/e2e/ps-forwarding.ts` 换成 `scripts/e2e/ps-authorizer.ts`。
- 修复（审批）：PS 转来的审批卡上点「始终批准」，会把工具名（如 `bash`）写进 `approval.autoApprove`，点「本会话批准」会记成
  本会话免审该工具；之后切回内置审批，这个工具就全部免审。外部来源的审批卡现在只由外部来源自己记录选择。
- 工作区：新增 `workspaces.default`，新会话默认在这个工作区里运行（不设仍是 pi 进程的启动目录）。
  管理员可在运行中用 `/workspace add <别名> <绝对路径>`、`/workspace rm <别名>`、`/workspace default <别名>|reset`
  增删工作区和设置默认，立即写入配置，不用重启（日志 `feishu.conv.workspace_added` / `workspace_removed` / `workspace_default_changed`）。
  `/workspace` 列出全部工作区并标出默认；目录只对管理员显示。
- **破坏性变更（页脚）**：回答页脚改为默认关闭（`footer.enabled` 默认 `false`）。`/feishu footer on|off` 仍只改当前会话；
  新增 `-g` 改全局默认（写入 `footer.enabled`，立即生效），`/feishu footer reset` 让当前会话改回跟随全局。
  日志 `feishu.footer.toggled` 增加 `scope`（`chat` / `global`）。
- **破坏性变更（管理员）**：启动时识别的隐式管理员只认应用归属人和协作者里的**应用管理员**（`type: administrator`）；
  开发者、运营以及角色不明的协作者不再当作管理员（此前所有协作者都算，能点审批卡、用管理员命令、绕过私聊白名单）。
  `onboarding.accessApprovers` 的 `owner_collaborators` 改为 `owner_admins`，运行时字段 `appCollaboratorIds` 改为 `appAdminIds`。
  启动日志 `feishu.config.app_owner_hydrated` 增加各角色人数（`appAdminCount`、`excludedCollaborators`）；
  角色不明时告警 `feishu.config.app_collaborator_type_unknown`。README「所需权限」补上 `application:application:readonly`。
- 审批：内置审批下 `feishu_ask`（向会话提选择题）不再弹审批卡 —— 它本身就在等人回答，不产生副作用。
  `pi-permission-system` 模式下仍由 pi-permission-system 的规则决定。
- **破坏性变更（审批）**：审批改为默认关闭。字段 `approval.policyEngine` 改为 `approval.mode`，取值
  `off`（默认，工具调用直接放行）/ `builtin`（内置：命令分级 + 审批卡，即原 `bridge`）/ `pi-permission-system`（交给该插件判定，取值与原来相同）；
  环境变量 `FEISHU_CHANNEL_POLICY_ENGINE` 改为 `FEISHU_CHANNEL_APPROVAL_MODE`，取值不对时拒绝启动。旧字段、旧值不再识别。
  **要保留审批，在配置里写 `"approval": { "mode": "builtin" }`。**
  - `/feishu approvals off|builtin|pi-permission-system`：管理员只改当前会话（内存，重启失效）；加 `-g` 写入配置并立即生效；`reset` 回到全局。
  - 关闭模式下 `!<命令>`（`directBash`）也不再做命令分级。
  - 可观测：启动日志 `feishu.approval.mode`、切换日志 `feishu.approval.mode_changed`；`/feishu doctor` 新增 `approval_mode`；
    `/feishu status` 显示审批模式；全局模式不是 `off` 时 `features` 里列出 `approval`。
    插件没装上的日志由 `feishu.approval.policy_engine_unavailable` 改名为 `feishu.approval.plugin_unavailable`。
  - `/feishu approvals` 在 `bash` 位于免审名单时显示「免审」，不再误报「每条命令都弹审批卡」。
- 修复（审批）：点「始终批准」会用内存里的免审名单整个覆盖 `approval.autoApprove`，进程运行期间手工加进
  配置文件的工具被冲掉。现在写入前先合并文件里当前的名单，合并结果同时在内存里生效。
- 修复：没设 `FEISHU_CHANNEL_HOME` 时桥起不来，日志 `extension_error session_start "pi.getAgentDir is not a function"`。
  pi 传给扩展的 API 对象上没有 `getAgentDir` 和 `ui`，入口却直接调用了它们。现在 agent 目录取自
  `@earendil-works/pi-coding-agent` 导出的 `getAgentDir()`（取不到时按 `PI_CODING_AGENT_DIR`、`~/.pi/agent` 推算），
  状态栏改用事件 ctx 上的 `ui`。附带修好两处一直没生效的地方：pi 状态栏的 `feishu-conn` / `feishu-bridge`，
  以及没设 `PI_CODING_AGENT_DIR` 时对 pi-permission-system 是否安装的检测（此前会去 `cwd/pi-agent` 下找）。
- 新增运维 skill `feishu-channel-ops`（`skills/feishu-channel-ops/`，经 `pi.skills` 随包发布）：配置修改、健康检查、
  消息被丢的排查、常见症状速查和上线验收，供 agent 在配置和排障时加载。
- 运行环境：最低 Node 版本改为 22（Node 20 已于 2026-04-30 停止维护）；CI 在 Node 22 与 24 上运行。
- 修复（审批）：pi-permission-system 转发来的审批卡只显示规则匹配到的那一段命令 —— 例如实际执行
  `echo x > ~/.bashrc` 时卡片上只显示 `echo x`。现在显示完整命令，理由里注明规则匹配的部分。
- 配置：`config.json` 的每个字段都按类型和取值校验（zod schema），出错时列出全部问题及完整字段路径，
  例如 `配置无效：config.groupRules.oc_xxx.policy：群策略「everyone」无效（可选 open/mention/…）`。
  **比以前严格**：此前被静默容忍的写法（开关写成字符串 `"yes"`、数组位置写成单个字符串、负的超时等）现在会让启动失败。
  合法配置的加载结果不变。
- 修复（审批）：bash 命令分级（只读免审、危险直接拒绝）此前一直没有生效 —— 分级读的是卡片展示用的参数文本
  （已打码、截断到 1500 字），解析不出命令，所有 bash 调用都落到弹卡审批。现在改用原始命令分级；
  危险部分出现在 1500 字之后也能识别。只影响 `approval.policyEngine` 为默认 `bridge` 的部署。
- 项目更名为 `pi-feishu-channel`（原 `pi-feishu-bridge`）。安装地址改为 `git:github.com/chenydev/pi-feishu-channel`；
  子会话剔除网关扩展时同时识别新旧两个名字。
- 运行时标识同步更名：
  - 运行时目录 `feishu-bridge/` → `feishu-channel/`。首次启动时自动改名，原位置留指向新目录的软链接
    （日志 `feishu.config.migrated`）；新旧都在时只用新目录（`feishu.config.legacy_dir_ignored`）；
    改名失败时不启动（`feishu.config.migrate_failed`）。
  - 环境变量 `FEISHU_BRIDGE_HOME` / `FEISHU_BRIDGE_POLICY_ENGINE` → `FEISHU_CHANNEL_*`。旧名仍然识别，启动时告警
    （`feishu.config.deprecated_env`）。
  - 日志前缀 `[feishu-bridge]` → `[feishu-channel]`；PS 父会话默认 id `feishu-bridge-parent` → `feishu-channel-parent`
    （可用 `approval.forwarding.parentSessionId` 固定为旧值）。
- 可观测：启动日志 `feishu.bridge.features`、`status.json` 的 `features` 字段与 `/feishu doctor` 的 `features` 项，
  列出当前打开的默认关闭能力（11 项可选能力 + 流式卡片、PS 父会话转发）。

## 0.2.0

### 可靠性

- 审批：同一轮同一工具的并发请求合并到一张卡（点一次全部生效）；超时前 1 分钟 @ 管理员提醒；卡片展示触发上下文。
- 出站：飞书权限类错误（230002/230006/230013/230027/99991672）判为永久失败，不再无效重试。
- 撤回：用户撤回消息 → 取消尚未开始的批次/排队任务。
- `status.json` 每 30s 心跳刷新（`statusHeartbeatMs`）；`/feishu doctor` 新增心跳过期、连接抖动、未知配置字段三项检查。
- SIGTERM 优雅退出有 8s 总预算（`FEISHU_SHUTDOWN_BUDGET_MS`），超时强制退出并记日志。
- run 失败按类别给出下一步建议（限流 / 上下文超限 / 鉴权 / 网络 / 服务端），附可 grep 的错误编号，原始错误只进日志。
- 会话文件权限收紧为 0600；可选按天归档旧会话（`retention.sessionDays`，默认不归档）。

### 交互与命令

- 命令注册表统一：`/help` 为分组卡片（按钮一键执行），未知命令给出"你是不是想输入…"。
- 新命令：`/retry` `/undo` `/fork` `/export [html|md|summary]` `/steer` `/queue list|clear`
  `/feishu approvals` `/feishu prompt` `/feishu budget` `/feishu usage week` `/cron`。
- `/model` 支持模糊匹配、"最近使用"与快速切换按钮；`/sessions` 为卡片，可一键恢复；`/new` 回执带"恢复上一个会话"按钮。
- 忙碌时：并入当前任务的消息加「+1」表情（`reaction.steerEmoji`），排队的消息回复"已排队，第 N 个"（`queueNotice`）。
- 完成页脚显示步骤摘要（`✅ 完成 · 12.4s · 共 N 步（…）`）。
- 入群欢迎卡；未放行群被 @ / 被拉群时私聊管理员"放行此群"卡。
- 管理员分三种角色展示：应用归属人 / 应用协作者 / 管理员（`/feishu doctor` 按角色计数）。
- 群开通审批权限可配置 `onboarding.accessApprovers`：默认 `owner`（仅应用归属人），可放宽为 `owner_collaborators` / `all`；只把申请发给、只允许点击的是有权限的人。
- 私聊个人提示词（`userPrompts`，`/feishu prompt set` 在私聊里写）。
- 表情反馈计数（`feedback.enabled`，默认开，只记计数）。

### 新能力（默认全部关闭）

| 能力 | 开关 |
|---|---|
| 超长回答转 .md 附件 | `longReply.asFile` |
| 管理员 `!<命令>` 直接执行（经命令分级 + PS 规则把关、审计日志） | `directBash.enabled` |
| 定时任务 | `cron.enabled` |
| 桥自身告警私聊管理员 | `alerts.enabled` |
| agent 自定义卡片工具 `feishu_card`（HMAC 签名回调） | `cardTool.enabled` |
| 语音转写（OpenAI 兼容接口） | `stt.provider: "openai"` |
| 群每日费用上限 | `groupRules.<chatId>.dailyBudgetUsd` / `/feishu budget` |
| 云文档评论里 @ 机器人 → 评论区回复 | `docComments.enabled` |
| 会议邀请 → 邀请人私聊里开任务 | `meetingInvite.enabled` |
| agent 读取云文档工具 `feishu_doc_read` | `docTools.enabled` |
| 开通申请：未放行群里有人 @ 机器人 → 归属人/协作者/管理员在群里则群内弹审批卡并 @（按角色展示与排序），否则私聊应用归属人；群里回告申请人 | `onboarding.accessRequest` |

### 可维护性

- 用量提供方可插拔（`usage.provider: "deepseek" | "none"`，默认 deepseek，行为不变）。
- 会话管理器拆分：`ProgressTracker`（进度）、`RunExecutor`（单轮执行）、`SessionScheduler`（调度/公平性）、`ConversationCommands`（模型/思考/历史会话/工作区命令）；删除死代码。
- `piAgentDir` 取自 `pi.getAgentDir()`；PS 安装探测缓存 60s。
- `npm run lint` = tsc 未使用变量检查 + biome lint；GitHub Actions CI（Node 20/22）；飞书假服务端的平台约束集成测试。
- `@larksuiteoapi/node-sdk` 升级到 `^1.73.1`。

### 兼容性

- 配置向后兼容：新字段均可缺省。未知字段不会报错，只在 `/feishu doctor` 里提示（防拼错）。
- `/feishu help` 仍可用（`/help` 的别名）。

## 0.1.0

首个版本：可靠入站（待处理记录）、durable outbox、审批卡、流式输出、会话管理、页脚指标。
