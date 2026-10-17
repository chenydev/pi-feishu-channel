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
| `permissions`、`access_approvers` | 有效管理员（显式配置 + 应用归属人 / 应用管理员）、谁能批准开通 |
| `config_fields` | 配置里无法识别的字段（通常是拼错了）；不报错，只提示 |
| `backlog`、`pending_work`、`rate_budget`、`error_state` | 积压、未完成任务、限流冷却、最近错误类别 |
| `approval_mode` | 全局审批模式（关闭 / 内置 / 插件）及来源；会话里的临时设置看 `/feishu approvals` |
| `ps_link`、`ps_always_approved` | 模式为 pi-permission-system 时：它的版本是否 ≥ 27.0.0、`authorizerChain` 里有没有 `feishu-channel`、挂上了几个会话；「始终批准」的规则 |
| `session_dir`、`outbox_dir`、`runtime` | 目录可写、运行环境 |

**谁看得到详情**：`detail` 里有宿主绝对路径、配置字段名、「始终批准」的规则名，所以只有管理员能看到；
其他被准入的人发 `/feishu doctor` 只拿到「✅/❌ 检查项 + 异常条数」，排查具体问题要找管理员。

### 1.3 改了 config.json 之后

管理员在飞书里发 `/feishu config reload`，不用重启：

- 能热加载的字段（[configuration.md](configuration.md) 「改后」列为「热加载」）立即生效。群设定 `prompt`、工具档位 `tools`、默认工作区只在会话开始时用，对新会话生效；
- 要重启的字段（应用凭据、超时、缓存容量、定时器间隔、可选能力的开关）不会应用，回执里列出来，重启后才生效；
- 文件有错误时不应用任何改动，回执和日志里给出出错的字段；
- 环境变量优先于文件：设了同名环境变量的字段，改文件不算改动。

改了会话模式（`groupSessionsPerUser` 或某个群的 `groupRules.<id>.sessionsPerUser`）时，这些群驻留在内存里的空闲会话会立即释放，下一条消息按新的会话键从文件恢复；
有任务在跑的会话不释放，回执里会提示，所以改会话模式最好挑没有任务的时候。

日志 `feishu.config.reloaded`（`applied` 已生效、`restartRequired` 要重启的字段；改了会话模式时还有 `releasedSessions`、`busySessions`）、`feishu.config.reload_failed`（`error`）。

运行中的命令（`/feishu policy`、`/feishu footer`、群开通审批、「始终批准」等）会把内存里的值写回对应字段。手改了这些字段要先 reload 再用命令，否则手改的内容会被覆盖。

## 2. 一条消息走到哪了

按照消息的路径逐层查日志，每一层都有对应的事件：

| 环节 | 正常事件 | 异常事件 |
|---|---|---|
| 连接 | `feishu.transport.ws_ready`、`ws_reconnected` | `ws_reconnecting`、`ws_error` |
| 收到 | `feishu.conv.event` | `feishu.transport.drop_malformed`、`drop_self_echo` |
| 去重 / 合批 | `feishu.pipeline.batched` | `feishu.pipeline.drop_duplicate` |
| 准入 | —— | **`feishu.pipeline.drop`**（见 §3） |
| 命令 | `feishu.command` | `feishu.card.command_failed` |
| 执行 | `feishu.session.resource_loader_ready`（`strippedGateways` 正常为 1）、`feishu.session.created`、`feishu.conv.send_reply_start` | `feishu.conv.run_error`、`run_idle_timeout`（`phase`：`tool` 卡在工具，带 `tool` / `toolMs`；`model` 卡在等模型）、`model_retry`（pi 自动重试，带 `attempt` / `error`）、`model_quiet`（等模型 1 分钟没有输出）、`budget_exceeded` |
| 审批 | `feishu.approval.mode`（启动时的全局模式）、`mode_changed`、`audit`、`command_allow` / `command_ask` / `command_deny`；pi-permission-system 模式：`ps_link`、`ps_link_decision`、`ps_always_approved`、`ps_session_approved` | `feishu.approval.invalidated`、`card_terminal_failed`、`plugin_unavailable`、`ps_link_not_in_chain`、`ps_version_unsupported`、`ps_link_capped`、`ps_link_unavailable` |
| 回复 | `feishu.conv.reply_sent`、`feishu.outbox.delivered`、`feishu.stream_card.finished`；卡片超过 10 分钟后 `streaming_closed`（改用整组件替换，正常） | `feishu.outbox.failed`、`feishu.sender.*_fallback`、`feishu.stream_card.update_failed`、`fallback_to_text` |

**以最终效果为准**：看到 `tool_execution_*` 只说明过程发生了；要确认功能可用，得看 agent 的回复里有没有命令的真实输出。

## 3. 消息被丢了

准入是**默认拒绝**的：白名单为空表示全部拒绝。所以「消息被丢」很常见，而丢弃日志会说明原因。

### 准入顺序

「管理员」= `admins` + 应用归属人 + 应用管理员（后两者启动时自动识别，协作者里的开发者、运营不算）。
实现见 `src/inbound/admit.ts`，按下面的顺序判断，第一个不通过的就丢弃：

1. **机器人自己发的消息**：直接丢弃（`feishu.transport.drop_self_echo`），防止自己触发自己。
2. **同一条消息重投**：只处理一次。
3. **发送者是机器人或应用**：要在 `allowBots` 里（`app_id`、open_id，或特殊值 `"mentions"`：@ 了本机器人就放行），否则 `bots_disabled`。
4. **私聊**：在 `allowUsers` 里或是管理员就放行，否则 `dm_policy_rejected`。私聊不看 @。
5. **群聊**（话题群也算）依次过三层：
   1. **群白名单**：群在 `allowChats` 里，或发送者在 `allowUsersAllGroups` 里；否则 `not_allowlisted`。管理员**不能**跳过这一层。
   2. **群策略**（谁能用）：管理员跳过这一层。策略取值优先级 `groupPolicyByChat` > `groupRules.<群>.policy` > `defaultGroupPolicy` > `groupPolicy`。
      - `disabled`：全部拒绝；`admin_only`：只有管理员；
      - `allowlist`：只有 `groupRules.<群>.allowlist` 里的人（名单为空 = 不限制；`allowUsersAllGroups` 里的人可以跳过）；
      - `blacklist`：`blacklist` 里的人拒绝（`allowUsersAllGroups` 不能跳过）；
      - `open` / `mention`：都通过。**两者在这一层没有区别**，要不要 @ 看下一层。
   3. **@ 检查**（所有人都要过，包括管理员）：`groupRules.<群>.requireMention` 优先，其次全局 `requireMention`（默认 true）。需要 @ 时，下面任一条成立就放行，否则 `bot_not_mentioned`：
      - 消息 @ 了本机器人；
      - `ignoreAtAll: false` 且 @ 了所有人（默认 `ignoreAtAll: true`，@所有人不算）；
      - `adminBypassMention: true` 且发送者是管理员（默认 false）；
      - `groupAlsoOnReply: true` 且回复的是机器人发的消息（默认 false）。

斜杠命令也要先过准入，没权限的人发命令一样被丢弃。卡片按钮各自校验：提问卡（`feishu_ask`）= 能在这里 @ 机器人的人；
审批卡 = 审批人；开通申请卡 = `onboarding.accessApprovers` 范围内的人。

想让群里不 @ 也响应：设 `requireMention: false`（或 `groupRules.<群>.requireMention: false`）。只把策略设为 `open` 不够。

### 丢弃日志

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
| `not_allowlisted` | 群不在 `allowChats` 里，或用户不在该群的 `allowlist` 里 | `allowChats` / `groupRules.<chatId>.allowlist`；只放行某个人在所有群使用：`allowUsersAllGroups` |
| `dm_policy_rejected` | 私聊未放行 | `allowUsers`（管理员始终放行） |
| `group_policy_rejected` | 群策略拒绝（`disabled` / `admin_only` / `blacklist`） | `groupPolicy` / `groupRules` |
| `bot_not_mentioned` | 群策略要求 @，但消息没有 @ 本机器人 | 在消息里 @，或修改群策略；想让「回复机器人的消息」免 @，开 `groupAlsoOnReply` |

开了开通申请（`onboarding.accessRequest`）时，下面三种拒绝会给审批人发申请卡，审批结果直接写回 `config.json`：

| 情况 | 卡片上的选项 | 写入 |
|---|---|---|
| 群不在 `allowChats` 里，有人 @ 机器人 | 放行此群 / 全局放行此人 / 暂不放行 | `allowChats` / `allowUsersAllGroups` |
| 群策略是 `allowlist`，名单外的人 @ 机器人 | 加入本群名单 / 全局放行此人 / 暂不放行 | `groupRules.<chatId>.allowlist` / `allowUsersAllGroups` |
| 不在 `allowUsers` 里的人私聊机器人 | 放行私聊 / 暂不放行 | `allowUsers` |

「全局放行此人」只放开所有群，不放开私聊。群策略 `disabled` / `admin_only` / `blacklist` 拒绝的不发申请。
频率限制：同一项申请（一个群 / 群里的一个人 / 私聊的一个人）在 `accessRequestCooldownMs`（默认 1 小时）内只发一次；
「暂不放行」后 24 小时内不再发；所有申请合计每小时最多 `accessRequestMaxPerHour` 次（默认 10）。
发出记 `feishu.access_request.sent`，放行个人记 `user_allowed`（`scope`：`chat` / `all_groups` / `dm`），没发记 `silent`（`reason`：`ignored` / `reminded` / `rate_limited`）。

另外，机器人自己发出的消息会在更早的环节被过滤（`feishu.transport.drop_self_echo`），以防自我触发的死循环。**所以不能用机器人自己的身份发消息来做测试。**

## 4. 常见症状

| 症状 | 通常的原因 | 怎么确认 / 修复 |
|---|---|---|
| 消息发了完全没反应 | 没有 @；群不在白名单里 | 查 `feishu.pipeline.drop` 的 `reason` |
| 改了 `config.json` 不生效 | 还没 reload 或重启；字段要重启才生效；有同名环境变量覆盖 | 发 `/feishu config reload`，看回执是「已生效」还是「要重启才生效」；都没列出来就是文件和运行中的一致，查环境变量。见 §1.3 |
| 开了开通申请，没权限的人找机器人却没收到申请卡 | 冷却期内已发过（`silent` 的 `reason: reminded`）、被「暂不放行」（`ignored`）、超出每小时上限（`rate_limited`）；或群策略本身拒绝（`group_policy_rejected` 不申请） | 查 `feishu.access_request.*`；急用时直接改 `config.json` 后 `/feishu config reload` |
| 回复机器人发的消息，没 @ 也触发了 | 开了 `groupAlsoOnReply`（默认关闭）：`mention` 策略下回复机器人的消息免 @ | 查 `config.json` 和环境变量 `FEISHU_GROUP_ALSO_ON_REPLY`；不要这个行为就设为 `false` 后 `/feishu config reload`。它对整个实例生效，不能按群或按人设置 |
| 开了 `groupAlsoOnReply`，回复机器人有时仍要 @ | 只认进程内存里最近 `lastSentCacheSize` 条（默认 64）机器人消息：重启前发的、或群里机器人发言多时较早的消息都认不出来 | 设计如此，@ 机器人即可；需要时调大 `lastSentCacheSize` |
| 桥没起来，日志 `extension_error session_start … pi.getAgentDir is not a function` | 扩展版本过旧，调用了 pi 扩展 API 上不存在的方法 | 升级扩展；临时绕过：设置 `FEISHU_CHANNEL_HOME` |
| 桥没起来，日志 `feishu.bridge.autostart_skipped` | `reason: disabled`：进程没设 `FEISHU_CHANNEL_ENABLED=1`（默认关闭）；`reason: mode`：不是 `pi --mode rpc` 启动的 | 部署的进程设上 `FEISHU_CHANNEL_ENABLED=1` 并用 `--mode rpc`（容器要重建才拿到新环境变量）；本地 TUI 里要连就 `/feishu:start` |
| `status.json` 显示已连接，却没反应 | 文件已经过期，进程早就停了 | 看 mtime；`/feishu doctor` 的 `status_heartbeat` |
| 连接反复断开又连上 | 同一个应用被多个进程同时连接 | 同一个应用只能有一个实例；锁冲突时启动报错 `bridge already running for appId …` |
| 审批卡没弹，命令直接执行了 | 审批模式是关闭（默认）；或策略里只有允许 / 拒绝，没有需要审批的规则 | `/feishu approvals` 看模式和来源；再查命令分级或 pi-permission-system 的规则 |
| 审批模式已关闭，仍有调用被拒绝 | 装了 pi-permission-system，它的拦截不受本扩展的模式影响 | 卸掉插件或在它的配置里放行 |
| pi-permission-system 的「询问」全被拒绝，不弹卡 | 它的 `authorizerChain` 里没写 `feishu-channel`，或版本低于 27.0.0 | `/feishu doctor` 的 `ps_link`；日志 `feishu.approval.ps_link_not_in_chain` / `ps_version_unsupported`；在它的配置里加 `"authorizerChain": ["feishu-channel"]` 后重启 |
| 读写工作目录以外的文件总被拒绝，不弹卡 | pi-permission-system 不允许授权链放行路径类请求（`path`、`external_directory`） | 日志 `feishu.approval.ps_link_capped`；在 pi-permission-system 的配置里放行这些路径 |
| 应用归属人 / 应用管理员不被当作管理员 | 应用没开 `application:application:readonly`，或协作者接口查询失败；开发者、运营本来就不算 | 看日志 `feishu.config.app_owner_hydrated`（各角色人数）或 `*_hydrate_failed`；开通权限后重启，或把 open_id 写进 `admins` |
| 点审批卡提示「已失效」 | 超时（默认 5 分钟），或这一轮已经结束 | 尽快点；或调大 `approval.timeoutMs` |
| 回复半截，或提示「回复发送失败」 | 编辑次数用尽、没有发言权限、接口持续报错 | 看 `feishu.outbox.failed` 的 `lastError` |
| 页脚费用一直显示「未知」 | 模型配置里没有费率 | 在 pi 的模型配置里补上 `cost` |
| 每开一个会话就多一条 `ws_ready`，连接互相顶掉 | 子会话没有剔除桥自身，又启动了一个长连接 | 看 `feishu.session.resource_loader_ready` 的 `strippedGateways`，应为 1 |
| 升级后启动失败，日志 `feishu.config.migrate_failed` | 旧目录 `feishu-bridge/` 改名为 `feishu-channel/` 失败（多为目录没有写权限，或两者不在同一个文件系统） | 按日志里的 `from` / `to` 手动 `mv`，再重启 |
| 日志 `feishu.config.legacy_dir_ignored` | 新旧目录同时存在，只用新目录 | 确认旧目录里没有要保留的东西后删除它 |
| 日志 `feishu.config.deprecated_env` | 还在用旧环境变量 `FEISHU_BRIDGE_*` | 改成日志里 `replacement` 给出的新名字 |
| 点提问卡片的选项提示「没有使用机器人的权限」 | 点击人在这个群里不能 @ 机器人（群没放行、不在群名单里等），作答权限和 @ 的准入规则一致 | 按 §3 放行这个人；或由能用机器人的人来点 |
| 点提问卡片提示「已过期」 | 已经答过、同一会话后来又发了新提问、执行过 `/new`，或超过 `clarify.ttlMs`（默认 24 小时） | 直接打字回复即可；日志 `feishu.clarify.audit` 的 `decision` 记着失效原因 |
| 任务被中止，提示「工具 … 没有输出」 | 工具执行中连续 `runToolIdleTimeoutMs`（默认 60 分钟）没有输出 | 确实要跑更久就调大它；日志 `feishu.conv.run_idle_timeout` 的 `tool` / `toolMs` |
| 任务被中止，提示「没有收到模型的任何输出」 | 等模型时连续 `runIdleTimeoutMs`（默认 10 分钟）没有输出，多半是模型服务卡住。DeepSeek 繁忙时先回响应头、再只发 `: keep-alive` 排队，最长 10 分钟才断开：pi 的 `httpIdleTimeoutMs`、`retry.provider.timeoutMs` 都拦不住，只能靠这个超时 | `/retry`，或 `/model` 换模型；常遇到可以把 `runIdleTimeoutMs` 调到 `180000`，早点结束排队 |
| 流式卡片一直停在「正在处理…」或半截内容，答案或中止说明另发了一条 | 旧版本：卡片开启约 10 分钟后飞书关闭流式模式，之后写入全部失败（日志 `feishu.stream_card.update_failed`，`200850` / `300309`） | 升级到包含 `feishu.stream_card.streaming_closed` 的版本 |
| 卡片或进度显示「模型服务暂时不可用，正在自动重试」或「可能在排队」 | 模型服务繁忙：前者是 pi 收到 503、限流等临时错误后在重试（默认 3 次），后者是 1 分钟没有任何输出 | 一般等着即可；不想等就 `/stop`，`/model` 换模型再发。日志 `feishu.conv.model_retry` / `model_quiet` |
| 不清楚消息上的表情代表什么 | 敲键盘 = 已收下（在排队或正在执行）；+1 = 已并入正在执行的那一轮；DONE = 处理完成；❌ = 处理失败。`/stop` 中止、`/queue clear` 清掉的消息不留表情。合批的几条消息都会加 DONE / ❌ | 要看排队用 `/queue list` 或 `/progress`。表情在 `reaction.*` 里改，`doneEmoji` 设为空字符串就不加完成表情 |
| 群里切到全群共用（`groupSessionsPerUser: false`，或该群 `groupRules.<id>.sessionsPerUser: false`）后，机器人不记得之前聊的内容 | 群的会话 key 变了，新消息进了新的共享会话；之前各人的个人会话文件都还在 | 在群里发 `/sessions`，找标着「某某 的个人会话」的那段，本人或管理员 `/resume #N`；恢复后这段上下文全群共用，日志 `feishu.conv.session_resumed` 带 `personalOwner`。几个人在群里各做各的事时，把这个群设回 `sessionsPerUser: true` 后 `/feishu config reload`，各人的会话就接上了 |
| 任务执行中发消息问进度，很久没回应 | 普通消息在工具执行中要等这一步结束才交给模型 | 发 `/progress`：立即回复，不打断任务 |
| 装了新技能 / 扩展，飞书会话里用不上 | 已建立的会话不会自动重新加载，只有新建的会话才读到 | 在该会话发 `/reload`（或 `/new`）；回执列出新增技能和加载失败的条目，日志 `feishu.conv.reloaded` / `reload_failed` |
| 容器日志时间差 8 小时 | `docker logs --timestamps` 始终是 UTC | 对时间时换算时区 |

## 5. 上线验收

改了代码或配置之后，本地测试通过**不等于**功能可用：准入、路由、卡片渲染和真人点击，只在真实链路里才会暴露问题。

`npm test` 在开发机和 CI（Node 22、24）上跑，不在部署环境里跑：pi 装扩展时用 `npm install --omit=dev`，
部署的 checkout 里没有 tsx 等开发依赖，也不要为了跑测试往里补装。部署环境只做下面的真实链路验收。

1. **重启**，日志里出现 `bridge started`（出现的是 `feishu.bridge.autostart_skipped`，按它的 `reason` 查：没设 `FEISHU_CHANNEL_ENABLED=1`，或不是 `pi --mode rpc`）。
2. **心跳**：`status.json` 的 mtime 在 90 秒以内，`connState` 为 `connected`。
3. **已启用能力**：日志 `feishu.bridge.features` 和 `status.json` 的 `features` 与预期一致。
4. **触发一轮带工具调用的对话**：在测试群里 @ 机器人，请它执行一条命令（例如「用 bash 执行 `echo SMOKE-1`，把输出原样告诉我」）。只问知识性问题不会调用工具，测不到审批链路。
5. **审批**：如果这条命令需要审批，由**管理员**点卡片（非管理员点不动）。日志里按顺序应当出现：审批请求 → 管理员的选择（含 `operatorOpenId`）→ `tool_execution_end`。
6. **以最终效果为准**：agent 的回复里有 `SMOKE-1`。

用群机器人 webhook 发测试消息可以触发链路，但 webhook 的发送者不是管理员，**点审批卡必须由真人来**。

### 不要这样测

- **不要在运行中的实例旁边再启动一个 pi 进程**：第二个进程会争抢同一个应用的连接，还会把 `status.json` 写成断开，让人误以为实例挂了。确实需要隔离测试时，给第二个进程设置独立的 `PI_CODING_AGENT_DIR` 和 `FEISHU_CHANNEL_HOME`。
- **不要用 `/proc/<pid>/environ` 检查运行时设置的环境变量**：那是进程启动时的快照，看不到运行时对 `process.env` 的修改。
