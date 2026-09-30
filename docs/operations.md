# 运维与排障

本文说明怎么判断一个运行中的实例是否健康、消息卡在了哪一环，以及上线后怎么验收。
各个环节的职责见 [architecture.md](architecture.md)。

下文的 `<home>` 指状态目录：设置了 `FEISHU_CHANNEL_HOME` 时用它，否则是 pi 的 agent 目录（通常是 `~/.pi/agent`）。
状态文件在 `<home>/feishu-channel/` 下（从旧版升级时会自动迁移，见下文 `feishu.config.migrated`）。

## 1. 三个观测入口

| 入口 | 适合回答的问题 | 怎么看 |
|---|---|---|
| `status.json` | 进程还活着吗？连上了吗？有没有积压？ | `cat <home>/feishu-channel/status.json`，**同时看 mtime** |
| `/feishu doctor` | 配置和权限有没有问题？ | 在飞书里发送（pi 里的 `/feishu:status` 只显示连接与队列概况） |
| 结构化日志 | 某一条消息走到了哪一步？ | 所有日志以 `[feishu-channel]` 开头，事件名形如 `feishu.<模块>.<事件>` |

### 1.1 status.json

进程每 30 秒刷新一次这个文件（`statusHeartbeatMs`）。**mtime 距今超过 90 秒，说明进程已经停了**，这时文件里的 `connState: "connected"` 是过期数据，不可信。

| 字段 | 含义 | 异常信号 |
|---|---|---|
| `connState` | `connected` / `connecting` / `disconnected` / `error` | 长时间不是 `connected` |
| `downSince`、`lastError` | 本次断线开始时间与最近错误 | 有值且持续存在 |
| `reconnectsLast5m` | 最近 5 分钟的重连次数 | 持续偏高 = 连接抖动，这时 `connected` 和 mtime 都不可信 |
| `sessionQueues` | 排队 / 执行中 / 等待执行槽的会话数 | `waiting` 持续大于 0 = 并发上限不够 |
| `pendingApprovals` | 未决审批数 | 长期不为 0 = 没人点，或卡片没发出去 |
| `outbox` | 待发 / 发送中 / 已发 / 失败 / 最老一条的等待时长 | `failed` 增长，或 `oldestAgeMs` 持续变大 |
| `messageTotal`、`messageDropped` | 收到的消息数与准入丢弃数 | 丢弃比例突然升高 = 配置变了 |
| `compensatedMessages` 等 | 断线补收的消息数、错误数、截断数 | `compensationErrors` 增长 |

### 1.2 /feishu doctor

每一项输出 `ok` 或具体问题：

| 检查项 | 内容 |
|---|---|
| `credentials`、`bot_identity`、`feishu_scopes` | 凭据、机器人身份、开放平台权限 |
| `transport`、`connection_stability`、`status_heartbeat` | 连接状态、抖动、心跳是否过期 |
| `permissions`、`access_approvers` | 有效管理员（显式配置 + 应用归属人 / 协作者）、谁能批准开通 |
| `config_fields` | 配置里无法识别的字段（通常是拼错了）；不报错，只提示 |
| `backlog`、`pending_work`、`rate_budget`、`error_state` | 积压、未完成任务、限流冷却、最近错误类别 |
| `ps_forwarding`、`ps_always_approved` | pi-permission-system 转发状态与「始终批准」规则 |
| `session_dir`、`outbox_dir`、`runtime` | 目录可写、运行环境 |

## 2. 一条消息走到哪了

按照消息的路径逐层查日志，每一层都有对应的事件：

| 环节 | 正常事件 | 异常事件 |
|---|---|---|
| 连接 | `feishu.transport.ws_ready`、`ws_reconnected` | `ws_reconnecting`、`ws_error` |
| 收到 | `feishu.conv.event` | `feishu.transport.drop_malformed`、`drop_self_echo` |
| 去重 / 合批 | `feishu.pipeline.batched` | `feishu.pipeline.drop_duplicate` |
| 准入 | —— | **`feishu.pipeline.drop`**（见 §3） |
| 命令 | `feishu.command` | `feishu.card.command_failed` |
| 执行 | `feishu.session.resource_loader_ready`（`strippedGateways` 正常为 1）、`feishu.session.created`、`feishu.conv.send_reply_start` | `feishu.conv.run_error`、`run_idle_timeout`、`budget_exceeded` |
| 审批 | `feishu.approval.audit`、`command_allow` / `command_ask` / `command_deny` | `feishu.approval.invalidated`、`card_terminal_failed` |
| 回复 | `feishu.conv.reply_sent`、`feishu.outbox.delivered` | `feishu.outbox.failed`、`feishu.sender.*_fallback` |

**以最终效果为准**：看到 `tool_execution_*` 只说明过程发生了；要确认功能可用，得看 agent 的回复里有没有命令的真实输出。

## 3. 消息被丢了

准入是**默认拒绝**的：白名单为空表示全部拒绝。所以「消息被丢」很常见，而丢弃日志会说明原因：

```
[feishu-channel] feishu.pipeline.drop {
  messageId: 'om_…', chatId: 'oc_…', chatType: 'group',
  reason: 'bots_disabled',
  senderId: 'ou_…',
  hint: '非人类发送者不在 allowBots 白名单。放行方式（任选其一）：…'
}
```

`hint` 会结合当前配置，直接告诉你该改哪个字段、加什么值。它只在消息 **@ 了本机器人**时给出（私聊总是给出）；群里的闲聊只记 `reason`，否则日志会被刷屏。

| reason | 含义 | 对应配置 |
|---|---|---|
| `bots_disabled` | 发送者是机器人或应用，但不在 `allowBots` 里 | `allowBots`；也可以用特殊值 `"mentions"`：任何 @ 了本机器人的 bot 都放行，不依赖 ID，换应用也不会失效 |
| `not_allowlisted` | 群不在 `allowChats` 里，或用户不在该群的 `allowlist` 里 | `allowChats` / `groupRules.<chatId>.allowlist` |
| `dm_policy_rejected` | 私聊未放行 | `allowUsers`（管理员始终放行） |
| `group_policy_rejected` | 群策略拒绝（`disabled` / `admin_only` / `blacklist`） | `groupPolicy` / `groupRules` |
| `bot_not_mentioned` | 群策略要求 @，但消息没有 @ 本机器人 | 在消息里 @，或修改群策略 |

另外，机器人自己发出的消息会在更早的环节被过滤（`feishu.transport.drop_self_echo`），以防自我触发的死循环。**所以不能用机器人自己的身份发消息来做测试。**

## 4. 常见症状

| 症状 | 通常的原因 | 怎么确认 / 修复 |
|---|---|---|
| 消息发了完全没反应 | 没有 @；群不在白名单里 | 查 `feishu.pipeline.drop` 的 `reason` |
| `status.json` 显示已连接，却没反应 | 文件已经过期，进程早就停了 | 看 mtime；`/feishu doctor` 的 `status_heartbeat` |
| 连接反复断开又连上 | 同一个应用被多个进程同时连接 | 同一个应用只能有一个实例；锁冲突时启动报错 `bridge already running for appId …` |
| 审批卡没弹，命令直接执行了 | 策略里只有允许 / 拒绝，没有需要审批的规则 | 检查命令分级或 pi-permission-system 的规则 |
| 点审批卡提示「已失效」 | 超时（默认 5 分钟），或这一轮已经结束 | 尽快点；或调大 `approval.timeoutMs` |
| 回复半截，或提示「回复发送失败」 | 编辑次数用尽、没有发言权限、接口持续报错 | 看 `feishu.outbox.failed` 的 `lastError` |
| 页脚费用一直显示「未知」 | 模型配置里没有费率 | 在 pi 的模型配置里补上 `cost` |
| 每开一个会话就多一条 `ws_ready`，连接互相顶掉 | 子会话没有剔除桥自身，又启动了一个长连接 | 看 `feishu.session.resource_loader_ready` 的 `strippedGateways`，应为 1 |
| 升级后启动失败，日志 `feishu.config.migrate_failed` | 旧目录 `feishu-bridge/` 改名为 `feishu-channel/` 失败（多为目录没有写权限，或两者不在同一个文件系统） | 按日志里的 `from` / `to` 手动 `mv`，再重启 |
| 日志 `feishu.config.legacy_dir_ignored` | 新旧目录同时存在，只用新目录 | 确认旧目录里没有要保留的东西后删除它 |
| 日志 `feishu.config.deprecated_env` | 还在用旧环境变量 `FEISHU_BRIDGE_*` | 改成日志里 `replacement` 给出的新名字 |
| 容器日志时间差 8 小时 | `docker logs --timestamps` 始终是 UTC | 对时间时换算时区 |

## 5. 上线验收

改了代码或配置之后，本地测试通过**不等于**功能可用：准入、路由、卡片渲染和真人点击，只在真实链路里才会暴露问题。

1. **重启**，日志里出现 `bridge started`。
2. **心跳**：`status.json` 的 mtime 在 90 秒以内，`connState` 为 `connected`。
3. **已启用能力**：日志 `feishu.bridge.features` 和 `status.json` 的 `features` 与预期一致。
4. **测试**：在部署环境里执行一次 `npm test`（不只是在开发机上）。
5. **触发一轮带工具调用的对话**：在测试群里 @ 机器人，请它执行一条命令（例如「用 bash 执行 `echo SMOKE-1`，把输出原样告诉我」）。只问知识性问题不会调用工具，测不到审批链路。
6. **审批**：如果这条命令需要审批，由**管理员**点卡片（非管理员点不动）。日志里按顺序应当出现：审批请求 → 管理员的选择（含 `operatorOpenId`）→ `tool_execution_end`。
7. **以最终效果为准**：agent 的回复里有 `SMOKE-1`。

用群机器人 webhook 发测试消息可以触发链路，但 webhook 的发送者不是管理员，**点审批卡必须由真人来**。

### 不要这样测

- **不要在运行中的实例旁边再启动一个 pi 进程**：第二个进程会争抢同一个应用的连接，还会把 `status.json` 写成断开，让人误以为实例挂了。确实需要隔离测试时，给第二个进程设置独立的 `PI_CODING_AGENT_DIR` 和 `FEISHU_CHANNEL_HOME`。
- **不要用 `/proc/<pid>/environ` 检查运行时设置的环境变量**：那是进程启动时的快照，看不到运行时对 `process.env` 的修改。
