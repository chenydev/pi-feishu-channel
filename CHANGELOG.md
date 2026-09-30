# Changelog

本项目不打 tag 时请按 commit 钉版本（见 README「用 pi 从 git 安装」）。

## 未发布

- 项目更名为 `pi-feishu-channel`（原 `pi-feishu-bridge`）。安装地址改为 `git:github.com/chenydev/pi-feishu-channel`；
  运行时配置目录、环境变量暂不变。子会话剔除网关扩展时同时识别新旧两个名字。
- 可观测：启动日志 `feishu.bridge.features`、`status.json` 的 `features` 字段与 `/feishu doctor` 的 `features` 项，
  列出当前打开的默认关闭能力（11 项可选能力 + 流式卡片、PS 父会话转发）。

## 0.2.0

### 可靠性

- 审批：同一轮同一工具的并发请求合并到一张卡（点一次全部生效）；超时前 1 分钟 @ 管理员提醒；卡片展示触发上下文。
- 出站：飞书权限类错误（230002/230006/230013/230027/99991672）判为永久失败，不再无效重试。
- 撤回：用户撤回消息 → 取消尚未开始的批次/排队任务。
- `status.json` 每 30s 心跳刷新（`statusHeartbeatMs`）；`/feishu doctor` 新增心跳陈旧、连接抖动、未知配置字段三项检查。
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

首个版本：可靠入站（接管账本）、durable outbox、审批卡、流式输出、会话管理、页脚指标。
