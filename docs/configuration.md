<!-- 本文件由 npm run docs:config 从 src/config/schema.ts 生成，不要手工修改。 -->

# 配置参考

配置文件是 `<home>/feishu-channel/config.json`。`<home>` 是环境变量 `FEISHU_CHANNEL_HOME` 指定的目录，没有设置时是 pi 的 agent 目录（通常是 `~/.pi/agent`）。
完整示例见仓库根目录的 [config.example.json](../config.example.json)。

- **全部字段都是可选的**，没写的取下表的默认值。默认值为「—」的字段表示不设置（对应的功能按说明里的方式处理）。
- **环境变量优先于配置文件**：设置了表中的环境变量时，以环境变量为准（注意 shell 里残留的同名变量会静默覆盖配置文件）。
- **启动时校验**：类型或取值不对时拒绝启动，并一次列出全部问题，例如 `配置无效：config.progress.mode：进度档位「quiet」无效（可选 off/new/all/verbose）`。
- **拼错的字段不会报错**，但 `/feishu doctor` 的 `config_fields` 项会列出来。
- 以 `_` 或 `$` 开头的键当注释用（如 `"_comment"`），不校验。
- 时长字段的单位都是毫秒。

## 顶层字段

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `appId` | string | `""` | `FEISHU_APP_ID` | 飞书应用的 App ID（`cli_` 开头）。必填 |
| `appSecret` | string | `""` | `FEISHU_APP_SECRET` | 飞书应用的 App Secret。必填；建议用环境变量提供，不要写进文件 |
| `domain` | "feishu" \| "lark" | `"feishu"` | `FEISHU_DOMAIN` | `feishu`（飞书）或 `lark`（Lark 国际版） |
| `timezone` | string | `"Asia/Shanghai"` | `FEISHU_TIMEZONE` | 面向用户显示时间用的时区（IANA 名，如 `Asia/Shanghai`）。优先级：环境变量 > 本字段 > 容器的 `TZ` > `Asia/Shanghai`；无效值会被跳过，不会导致启动失败 |
| `groupPolicy` | "open" \| "mention" \| "disabled" \| "allowlist" \| "blacklist" \| "admin_only" | `"mention"` | `FEISHU_GROUP_POLICY` | 群聊的默认触发策略：`mention` @ 机器人才响应；`open` 所有消息都响应；`disabled` 不响应群消息；`allowlist` / `blacklist` 按群规则里的名单；`admin_only` 只响应管理员 |
| `groupPolicyByChat` | { [id]: "open" \| "mention" \| "disabled" \| "allowlist" \| "blacklist" \| "admin_only" } | `{}` | `FEISHU_GROUP_POLICY_BY_CHAT`（JSON） | 按群覆盖触发策略（群 id → 策略），优先于 `groupPolicy`。新配置建议用 `groupRules` |
| `groupRules` | { [id]: 对象 } | `{}` | `FEISHU_GROUP_RULES`（JSON） | 按群的完整规则（群 id → 规则），字段见下表 |
| `defaultGroupPolicy` | "open" \| "mention" \| "disabled" \| "allowlist" \| "blacklist" \| "admin_only" | — |  | 没有群规则的群使用的策略；不设时用 `groupPolicy` |
| `allowChats` | string[] | `[]` | `FEISHU_ALLOW_CHATS`（逗号分隔） | 允许使用机器人的群 id。**空数组 = 拒绝所有群** |
| `allowUsers` | string[] | `[]` | `FEISHU_ALLOW_USERS`（逗号分隔） | 允许私聊机器人的用户 open_id。**空数组 = 拒绝所有私聊**；管理员与应用归属人始终可以私聊 |
| `adminBypassMention` | boolean | `false` |  | 管理员与应用归属人在群里是否可以不 @ 机器人直接触发 |
| `admins` | string[] | `[]` | `FEISHU_ADMINS`（逗号分隔） | 管理员 open_id。管理员不受群策略限制（是否仍需 @ 见 `adminBypassMention`），可以审批工具调用、执行管理命令。应用归属人与协作者启动时自动识别，不用写进来 |
| `allowBots` | string[] | `[]` |  | 允许触发机器人的其它机器人或应用：`app_id`（`cli_` 开头，换应用也不变，推荐）、机器人的 open_id（换应用后会变），或特殊值 `"mentions"`（任何 @ 了本机器人的机器人都放行）。空数组 = 拒绝所有机器人发的消息 |
| `runIdleTimeoutMs` | number | `600000`（10 分钟） |  | 一轮任务连续多久没有任何进展就中止（毫秒；0 = 不限制） |
| `runMaxDurationMs` | number | `0` |  | 一轮任务的总时长上限（毫秒；0 = 不限制） |
| `ignoreAtAll` | boolean | `true` |  | 忽略「@所有人」。设为 false 时，@所有人 等同于 @ 本机器人（仍受群策略和白名单约束） |
| `groupAlsoOnReply` | boolean | `true` | `FEISHU_GROUP_ALSO_ON_REPLY` | `mention` 策略下，回复机器人发出的消息时不用再 @ |
| `groupSessionsPerUser` | boolean | `true` |  | 群里每个人各用一个独立会话；设为 false 时全群共用一个会话。话题里始终共用该话题的会话 |
| `requireMention` | boolean | `true` | `FEISHU_REQUIRE_MENTION` | 群里是否必须 @ 机器人才触发 |
| `queueNotice` | boolean | `true` |  | 忙碌时排队的消息回复一次「已排队」（同一会话 10 秒内只提示一次） |
| `userPrompts` | { [id]: string } | — |  | 私聊的个人提示词（open_id → 提示词）；在私聊里用 `/feishu prompt set` 设置 |
| `statusHeartbeatMs` | number | `30000`（30 秒） |  | `status.json` 的刷新间隔（毫秒；0 = 不定时刷新） |
| `footerByChat` | { [id]: boolean } | `{}` |  | 按群开关页脚（群 id → 是否显示），优先于 `footer.enabled`；在群里用 `/feishu footer on\|off` 设置 |
| `sessionDir` | string | `"sessions/feishu"` |  | 保留字段，目前不生效：会话文件固定在运行时目录的 `sessions/` 下 |
| `debug` | boolean | `false` | `FEISHU_DEBUG` | 输出调试日志 |
| `lastSentCacheSize` | number | `64` |  | 记住最近多少条机器人发出的消息（判断「是不是在回复机器人」） |
| `quotedFetchTtlMs` | number | `300000`（5 分钟） |  | 被回复消息原文的缓存时间（毫秒） |
| `dedupCacheSize` | number | `4096` |  | 消息去重记录的容量 |
| `dedupTtlMs` | number | `86400000`（24 小时） |  | 消息去重记录的保留时间（毫秒） |
| `maxActiveSessions` | number | `8` |  | 同时运行的会话上限，超出的排队等待 |

## `groupRules.<id>`：groupRules 里每一项的字段

不设的字段沿用对应的全局设置。

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `groupRules.<id>.policy` | "open" \| "mention" \| "disabled" \| "allowlist" \| "blacklist" \| "admin_only" | — |  | 这个群的触发策略，取值同 `groupPolicy` |
| `groupRules.<id>.allowlist` | string[] | — |  | `allowlist` 策略下允许触发的用户 open_id |
| `groupRules.<id>.blacklist` | string[] | — |  | `blacklist` 策略下不允许触发的用户 open_id |
| `groupRules.<id>.requireMention` | boolean | — |  | 这个群是否必须 @ 机器人才触发 |
| `groupRules.<id>.prompt` | string | — |  | 这个群的设定（会话开始时告诉 agent 一次，之后留在会话历史里） |
| `groupRules.<id>.tools` | "readonly" \| "standard" \| "full" \| string[] | — |  | 这个群里 agent 可用的工具：`readonly`（只读工具：read/grep/find/ls/网页搜索等）、`standard`（除 bash 以外的全部工具）、`full`（全部工具），或工具名数组 |
| `groupRules.<id>.dailyBudgetUsd` | number | — |  | 这个群每天的费用上限（美元）。用尽后当天不再接新任务（进行中的不打断）；也可以用 `/feishu budget` 设置 |

## `batch`：连续消息合并

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `batch.enabled` | boolean | `true` |  | 把同一个人短时间内连发的多条消息合并成一轮处理 |
| `batch.textWindowMs` | number | `3000`（3 秒） |  | 合并窗口（毫秒）：第一条消息之后这么久内的消息会被合并 |
| `batch.debounceMs` | number | `800` |  | 最后一条消息之后再等多久（毫秒）才开始处理 |
| `batch.media` | boolean | `false` |  | 图片、文件也参与合并 |
| `batch.maxMessages` | number | `8` |  | 一批最多合并多少条消息 |
| `batch.maxChars` | number | `12000` |  | 一批最多合并多少字 |

## `forwarding`：转发消息

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `forwarding.acceptMergeForward` | boolean | `true` |  | 接受「合并转发」的聊天记录，展开后交给 agent |

## `approval`：工具审批。详见 [approval.md](approval.md)

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `approval.autoApprove` | string[] | `[]` |  | 不需要审批的工具名 |
| `approval.timeoutMs` | number | `300000`（5 分钟） |  | 审批卡的有效期（毫秒），超时视为拒绝 |
| `approval.adminSkipApproval` | boolean | `false` |  | 管理员与应用归属人发起的工具调用不用审批 |
| `approval.policyEngine` | "bridge" \| "pi-permission-system" | `"bridge"` | `FEISHU_CHANNEL_POLICY_ENGINE` | 由谁判定工具调用：`bridge` 用内置规则 + 飞书审批卡；`pi-permission-system` 交给 pi-permission-system 扩展（扩展没装上时自动退回 `bridge`）。详见 [approval.md](approval.md) |
| `approval.commandPolicy.enabled` | boolean | `true` |  | 按 bash 命令分级：只读命令免审批，危险命令直接拒绝，其余弹审批卡 |
| `approval.commandPolicy.extraReadOnly` | string[] | — |  | 额外当作只读的命令名（按命令名匹配，如 `jq`） |
| `approval.commandPolicy.extraDangerous` | string[] | — |  | 额外当作危险的命令名（直接拒绝） |
| `approval.forwarding.enabled` | boolean | `false` | `FEISHU_PS_FORWARDING` | 父会话转发：把 pi-permission-system 的「询问」变成飞书审批卡（实验性） |
| `approval.forwarding.parentSessionId` | string | `"feishu-channel-parent"` |  | 转发用的父会话 id；必须稳定，且不能和任何真实会话 id 相同 |
| `approval.forwarding.alwaysApprove` | boolean | `true` | `FEISHU_PS_ALWAYS` | 审批卡上提供「始终批准」；命中已批准规则的请求直接放行。撤销用 `/feishu always revoke` |

## `reaction`：处理状态表情

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `reaction.processingEmoji` | string | `"Typing"` |  | 处理中加在原消息上的表情 |
| `reaction.enabled` | boolean | `true` |  | 处理消息时在原消息上加表情 |
| `reaction.failureEmoji` | string | `"CrossMark"` |  | 处理失败时加的表情；空字符串 = 不加 |
| `reaction.steerEmoji` | string | `"JIAYI"` |  | 忙碌时被并入当前任务的消息加的表情；空字符串 = 用 `processingEmoji` |

## `longReply`：超长回答转文件（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `longReply.asFile` | boolean | `false` |  | 超长回答只发开头，全文作为 .md 附件发送 |
| `longReply.thresholdChars` | number | `6000` |  | 超过多少字算超长 |
| `longReply.previewChars` | number | `1500` |  | 正文里保留的开头字数 |

## `directBash`：直接执行命令（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `directBash.enabled` | boolean | `false` |  | 管理员发 `!<命令>` 直接在宿主执行，不经过模型；同样经过 bash 命令分级，全部写审计日志 |
| `directBash.timeoutMs` | number | `60000`（1 分钟） |  | 命令超时（毫秒） |
| `directBash.allowAsk` | boolean | `false` |  | 分级为「需要审批」的命令也直接执行（默认拒绝） |
| `directBash.p2pOnly` | boolean | `false` |  | 只在私聊里可用 |

## `cron`：定时任务（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `cron.enabled` | boolean | `false` |  | 定时任务（只有管理员能增删） |
| `cron.catchUp` | "skip" \| "once" | `"skip"` |  | 停机期间错过的触发：`skip` 跳过（下次执行时注明错过了几次）；`once` 补跑一次 |
| `cron.maxJobs` | number | `20` |  | 最多多少个定时任务 |

## `alerts`：告警（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `alerts.enabled` | boolean | `false` |  | 出问题时私聊管理员：断线、连接抖动、消息永久发送失败、审批积压（带冷却和恢复通知） |
| `alerts.disconnectMs` | number | `120000`（2 分钟） |  | 断线超过多久告警（毫秒） |
| `alerts.reconnectsIn5m` | number | `10` |  | 5 分钟内重连超过多少次告警 |
| `alerts.pendingApprovals` | number | `5` |  | 待审批超过多少条告警 |
| `alerts.cooldownMs` | number | `1800000`（30 分钟） |  | 同类告警的最短间隔（毫秒） |
| `alerts.recipients` | string[] | — |  | 接收告警的 open_id；不设时发给全部管理员 |

## `onboarding`：入群与开通

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `onboarding.welcome` | boolean | `true` |  | 机器人被拉进已放行的群时发欢迎消息 |
| `onboarding.notifyAdmins` | boolean | `true` |  | 未放行的群里有人 @ 机器人时提示管理员 |
| `onboarding.accessRequest` | boolean | `false` |  | 开通申请：未放行的群里有人 @ 机器人时，把申请发给能审批的人（在群里弹审批卡，或私聊应用归属人），放行后通知申请人（可选能力，默认关闭） |
| `onboarding.accessRequestCooldownMs` | number | `3600000`（1 小时） |  | 同一个群两次开通申请的最短间隔（毫秒） |
| `onboarding.accessApprovers` | "owner" \| "owner_collaborators" \| "all" | `"owner"` |  | 谁能审批群开通：`owner` 只有应用归属人；`owner_collaborators` 加上应用协作者；`all` 再加上 `admins` |

## `feedback`：回复反馈

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `feedback.enabled` | boolean | `true` |  | 统计用户对回复点的 👍 / 👎（只记计数） |

## `cardTool`：agent 自定义卡片（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `cardTool.enabled` | boolean | `false` |  | 给 agent 一个 `feishu_card` 工具，用来发自定义交互卡片 |

## `stt`：语音消息转写（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `stt.provider` | "off" \| "openai" | `"off"` |  | `openai` = 调用 OpenAI 兼容的 `/audio/transcriptions` 接口 |
| `stt.endpoint` | string | — |  | 转写接口的地址 |
| `stt.model` | string | — |  | 转写模型名 |
| `stt.apiKeyEnv` | string | — |  | 存放 API key 的环境变量名（key 本身不写进配置） |
| `stt.maxBytes` | number | `20971520` |  | 语音文件大小上限（字节） |

## `retention`：会话归档

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `retention.sessionDays` | number | `0` |  | 超过这个天数的会话文件压缩归档；0 = 不归档（可选能力，默认关闭） |

## `docComments`：云文档评论（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `docComments.enabled` | boolean | `false` |  | 在云文档评论里 @ 机器人，机器人在评论区回复。需要订阅 `drive.notice.comment_add_v1` 事件与云文档评论权限 |
| `docComments.allowUsers` | string[] | — |  | 除管理员外，还有谁可以在评论里 @ 机器人 |
| `docComments.tools` | "readonly" \| "standard" \| "full" \| string[] | `"readonly"` |  | 评论区里 agent 可用的工具：`readonly`（只读工具：read/grep/find/ls/网页搜索等）、`standard`（除 bash 以外的全部工具）、`full`（全部工具），或工具名数组。评论区没有审批卡，缺省只读 |

## `meetingInvite`：会议邀请（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `meetingInvite.enabled` | boolean | `false` |  | 机器人被邀请进会议时，在邀请人的私聊里开一轮任务（只响应允许私聊的人） |

## `docTools`：云文档读取（可选能力，默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `docTools.enabled` | boolean | `false` |  | 给 agent 一个 `feishu_doc_read` 工具，读取云文档的纯文本 |
| `docTools.maxChars` | number | `30000` |  | 单次最多读取多少字 |

## `streamingCard`：流式卡片（默认关闭）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `streamingCard.enabled` | boolean | `false` | `FEISHU_STREAMING_CARD` | 用流式卡片展示处理过程；最终回答仍以普通消息发送（卡片失败不影响交付）。需要 `cardkit:card:write` 权限 |
| `streamingCard.throttleMs` | number | `1000`（1 秒） |  | 卡片更新的最短间隔（毫秒） |
| `streamingCard.printFrequencyMs` | number | `50` |  | 打字机效果：每次上屏的间隔（毫秒）。飞书平台默认 70，越小越快 |
| `streamingCard.printStep` | number | `50` |  | 打字机效果：每次上屏的字数。飞书平台默认 1（500 字要播 35 秒） |

## `footer`：回答页脚

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `footer.enabled` | boolean | `true` |  | 在最终回答末尾显示页脚（模型、耗时、token、上下文、费用） |
| `footer.showCost` | boolean | `true` |  | 页脚显示费用（美元） |
| `footer.showCny` | boolean | `true` |  | 页脚显示折算的人民币 |
| `footer.showContext` | boolean | `true` |  | 页脚显示上下文占用 |
| `footer.showSession` | boolean | `true` |  | 页脚显示会话编号 |

## `usage`：用量报告（`/feishu usage`）

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `usage.balanceTtlMs` | number | `300000`（5 分钟） |  | 账户余额查询结果的缓存时间（毫秒） |
| `usage.snapshots` | boolean | `true` |  | 记录余额快照，用来估算消耗速度 |
| `usage.provider` | "deepseek" \| "none" | `"deepseek"` |  | 账户余额从哪里查：`deepseek`；`none` = 不查余额，页脚也不折算人民币 |

## `sessionLifecycle`：空闲会话回收

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `sessionLifecycle.idleTtlMs` | number | `1800000`（30 分钟） |  | 会话空闲多久后释放内存（毫秒）。会话文件保留，下一条消息会自动恢复 |
| `sessionLifecycle.maxResidentSessions` | number | `32` |  | 内存里最多保留多少个会话 |
| `sessionLifecycle.sweepIntervalMs` | number | `60000`（1 分钟） |  | 空闲检查的间隔（毫秒） |

## `progress`：处理进度

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `progress.mode` | "off" \| "new" \| "all" \| "verbose" | `"all"` | `FEISHU_PROGRESS_MODE` | 处理过程的展示：`off` 不展示；`new` 只在换了工具时加一行；`all` 每次工具调用加一行；`verbose` 同 `all`，参数预览更长 |
| `progress.showThinking` | boolean | `false` |  | 展示模型的思考过程 |
| `progress.maxLines` | number | `6` |  | 进度消息最多显示多少行（至少 1） |
| `progress.previewChars` | number | `40` |  | 每行参数预览的长度（至少 4） |
| `progress.keepOnFinish` | boolean | `true` |  | 回答完成后保留进度消息；设为 false 时撤回 |

## `workspaces`：工作区

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `workspaces.aliases` | { [id]: string } | `{}` |  | 工作区别名（别名 → 目录）。只能切换到这里列出的目录；空 = 不允许切换工作区 |

## `agentContext`：给 agent 的上下文

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `agentContext.sender` | "shared" \| "always" \| "off" | `"shared"` |  | 在消息前加 `[发言人：张三]`：`shared` 只在多人共用的会话里加；`always` 群聊都加；`off` 不加 |
| `agentContext.mentions` | boolean | `true` |  | 消息里 @ 了别人时，告诉 agent 被 @ 的人是谁（姓名和 open_id） |

## `transport`：长连接

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `transport.sdkAutoReconnect` | boolean | `true` |  | 断线后先交给飞书 SDK 自动重连，超时仍未恢复才整体重建连接；设为 false 时完全由本扩展重连（排障用） |
| `transport.selfHealMaxMs` | number | `300000`（5 分钟） |  | SDK 自动重连超过多久仍未恢复就整体重建（毫秒） |

## 运行时字段

下面的字段在启动时从开放平台查询得到，不需要写进配置文件（写了会被查询结果覆盖）。

| 字段 | 类型 | 默认 | 环境变量 | 说明 |
|---|---|---|---|---|
| `botOpenId` | string | — |  | 机器人自己的 open_id。启动时从开放平台查询并覆盖，不用填 |
| `botUserId` | string | — |  | 机器人自己的 user_id。启动时查询，不用填 |
| `botName` | string | — |  | 机器人名称。启动时查询，不用填 |
| `implicitAdmins` | string[] | — |  | 启动时查询得到的应用归属人等隐式管理员。不要手写，也不会写回文件 |
| `appOwnerId` | string | — |  | 启动时查询得到的应用归属人 open_id |
| `appCollaboratorIds` | string[] | — |  | 启动时查询得到的应用协作者 open_id |
