---
name: feishu-channel-ops
description: pi-feishu-channel（pi 的飞书 / Lark 通道扩展）的配置与运维。用于：修改 config.json（群策略、白名单、管理员、审批、可选能力开关）；排查「@ 了机器人没反应」「消息被丢」「审批卡没弹 / 点不动 / 已失效」「连接反复断开」；读 status.json、/feishu doctor 与 feishu.* 日志；改动后的上线验收。Use when configuring, troubleshooting or verifying a Feishu/Lark bot powered by pi-feishu-channel.
---

# pi-feishu-channel 配置与运维

详细参考（相对本文件）：
- 配置字段全表：[../../docs/configuration.md](../../docs/configuration.md)
- 运维与排障：[../../docs/operations.md](../../docs/operations.md)
- 工具审批：[../../docs/approval.md](../../docs/approval.md)
- 示例配置：[../../config.example.json](../../config.example.json)

本文只给速查和决策流程；字段含义、默认值以 `configuration.md` 为准。

## 0. 先确认三件事

1. **状态目录 `<home>`**：设置了 `FEISHU_CHANNEL_HOME` 就是它，否则是 pi 的 agent 目录（通常 `~/.pi/agent`）。
   配置、状态都在 `<home>/feishu-channel/` 下：`config.json`、`status.json`、`sessions/`。
2. **在哪运行**：本机进程还是容器。只有设了 `FEISHU_CHANNEL_ENABLED=1` 的 `pi --mode rpc` 进程会自动连飞书，本机其他 pi 进程只是加载了扩展。容器里的命令要加 `docker exec <容器名>` 前缀，日志用 `docker logs`。
3. **你自己是不是跑在这个扩展里**（即当前对话来自飞书）：是的话，**不要重启、kill 或另起 pi 进程** —— 会中断自己所在的进程或抢占连接。把要执行的命令交给管理员。

## 1. 改配置

- 编辑 `<home>/feishu-channel/config.json` 后，管理员在飞书发 **`/feishu config reload`**：能热加载的字段立即生效；回执里「要重启才生效」的字段（应用凭据、超时、缓存容量、定时器间隔、可选能力开关）要重启进程。每个字段归哪类看 [configuration.md](../../docs/configuration.md) 的「改后」列。详见 [operations.md](../../docs/operations.md) §1.3。
- 启动时校验：类型或取值错误会拒绝启动，并一次列出全部问题；**拼错的字段不报错**，用 `/feishu doctor` 的 `config_fields` 项检查。
- **环境变量优先于配置文件**。改了文件不生效时，先查是不是有同名环境变量（如 `FEISHU_GROUP_POLICY`、`FEISHU_ALLOW_CHATS`）在覆盖。
- 凭据（`appId` / `appSecret`）建议走环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，不要写进文件，也**不要在回复或日志里输出 secret**。
- 运行中的进程会把部分字段写回文件：`/feishu policy`、`/feishu footer`、群开通审批（`allowChats`）、「始终批准」（`approval.autoApprove`）等。
  进程会用内存里的值覆盖这些字段，所以**手改同名字段后要立即 `/feishu config reload`**，别和运行中的命令交叉修改。
- 能用飞书命令改的优先用命令（即时生效，自动写回）：`/feishu policy <策略>`、`/feishu footer on|off|reset [-g]`（页脚默认关）、`/feishu approvals <模式> -g`、`/feishu prompt set <内容>`、`/feishu budget <美元>|off`、`/feishu always revoke <规则名>`、`/workspace add <别名> <绝对路径>` / `rm <别名>` / `default <别名>|reset`（工作区，不用重启）、`/feishu config reload`（手改文件后重新读取）。多数只有管理员能用。

### 准入是默认拒绝的

| 想要 | 改什么 |
|---|---|
| 让某个群能用 | 把群 id（`oc_` 开头）加进 `allowChats`。**空数组 = 拒绝所有群** |
| 让某人能私聊 | 把 open_id（`ou_` 开头）加进 `allowUsers`。**空数组 = 拒绝所有私聊**；管理员和应用归属人始终可以 |
| 群里不 @ 也响应 | `requireMention: false`（全局）或 `groupRules.<群id>.requireMention: false`（单个群）。**只把策略设为 `open` 不够**：`open` / `mention` 只管谁能用，要不要 @ 只看 `requireMention`（默认 true） |
| 群里每人一份上下文 | 全局 `groupSessionsPerUser: true`（默认 false：全群共用一个会话；话题始终按话题共用）；只改某个群用 `groupRules.<id>.sessionsPerUser: true / false`，`/feishu config reload` 即生效 |
| 回复机器人的消息不用 @ | `groupAlsoOnReply: true`（默认关）。全实例生效，不分群和人；只认最近 `lastSentCacheSize` 条（默认 64）机器人消息，重启清空 |
| 让某人在所有群都能用（含没放行的群） | 把 open_id 加进 `allowUsersAllGroups`。不放开私聊；群策略 `disabled` / `admin_only` / `blacklist` 仍然生效 |
| 只让部分人在某群使用 | `groupRules.<群id>.policy: "allowlist"` + `allowlist`（**名单为空 = 谁都不允许**，与 allowChats/allowUsers 一致） |
| 让其它机器人 / webhook 触发 | `allowBots` 加 `"mentions"`（任何 @ 了本机器人的 bot 都放行，不依赖 id，换应用不失效）；或加对方 `app_id` |
| 指定管理员 | `admins`（open_id）。应用归属人和应用管理员启动时自动识别（开发者、运营不算），**不用写** |
| 进度里每次工具调用都显示一行 | `progress.mode: "all"`（默认 `new`：只在换了工具时加一行；`off` 不显示） |
| 限制某群可用的工具 | `groupRules.<群id>.tools`：`readonly` / `standard` / `full` / 工具名数组 |

open_id 是**按应用生成**的：换了飞书应用，`admins`、`allowUsers`、`groupRules` 里的 open_id 和 `allowBots` 里的机器人 open_id 全部要重新确认。

### 可选能力默认关闭

`approval.mode`（工具审批）、`streamingCard`、`cron`、`alerts`、`directBash`、`longReply`、`docComments`、`docTools`、`cardTool`、`meetingInvite`、`stt`、`onboarding.accessRequest`、`groupAlsoOnReply`（回复机器人免 @）、`usage.provider: "deepseek"`（查余额、页脚折算人民币）都需要显式开启。

开通申请（`onboarding.accessRequest`）：未放行的群里 @、群名单外的人 @、未放行的人私聊，都给审批人（`onboarding.accessApprovers`）发申请卡；
审批人可选放行此群 / 加入本群名单 / 全局放行此人（写 `allowUsersAllGroups`，只放开群）/ 放行私聊，结果直接写回 `config.json`。
同一项申请 1 小时内只发一次，「暂不放行」后 24 小时不再发，合计每小时最多 `accessRequestMaxPerHour` 次（默认 10）。详见 [operations.md](../../docs/operations.md) §3。

工具审批：`approval.mode` 取 `off`（默认，直接放行）/ `builtin`（内置分级 + 审批卡）/ `pi-permission-system`（pi-permission-system）。
管理员在飞书里 `/feishu approvals <模式>` 只改当前会话（重启失效），加 `-g` 写入配置，`reset` 回到全局。
`off` 关不掉 pi-permission-system：装了它，它的拒绝照样生效。详见 [approval.md](../../docs/approval.md) §0。
用 `pi-permission-system` 模式时，要它的「询问」弹审批卡，**还要在它的配置里写 `"authorizerChain": ["feishu-channel"]`**，并且版本 ≥ 27.0.0
（`/feishu doctor` 的 `ps_link` 项检查这两点）。读写工作目录外的文件不能在卡上批准，需要时在它的配置里放行。详见 [approval.md](../../docs/approval.md) §3–4。
当前开了哪些：启动日志 `feishu.bridge.features`、`status.json` 的 `features` 字段、`/feishu doctor`。

## 2. 健康检查

```bash
H="${FEISHU_CHANNEL_HOME:-$HOME/.pi/agent}/feishu-channel"
stat -c 'mtime: %y' "$H/status.json"; date '+now:   %F %T'
cat "$H/status.json"
```

- **先看 mtime**：进程每 30 秒刷新一次，**mtime 距今超过 90 秒 = 进程已停**，这时文件里的 `connState: "connected"` 是过期数据。
- 再看：`connState`、`reconnectsLast5m`（持续偏高 = 抖动）、`sessionQueues.waiting`（持续 > 0 = 并发不够）、`pendingApprovals`、`outbox.failed` / `oldestAgeMs`、`messageDropped`。
- 配置和权限问题：在飞书里发 `/feishu doctor`，每项给出 `ok` 或具体问题（pi-permission-system 模式下看 `ps_link`）。

## 3. 排障：消息没反应

按顺序查日志（所有日志以 `[feishu-channel]` 开头，事件名 `feishu.<模块>.<事件>`）：

1. **进程活着吗** → §2 的 mtime。
2. **消息收到了吗** → `feishu.conv.event`。没有：连接问题（`feishu.transport.ws_*`），或者是机器人自己发的消息（`drop_self_echo`，设计如此）。
3. **准入放行了吗** → `feishu.pipeline.drop`。看 `reason`；消息 @ 了机器人时还有 `hint`，**直接照 `hint` 改**（它会结合当前配置给出该改的字段和值）。

| reason | 含义 | 改哪里 |
|---|---|---|
| `bots_disabled` | 发送者是 bot / 应用，不在 `allowBots` | `allowBots`（推荐 `"mentions"`） |
| `not_allowlisted` | 群不在 `allowChats`，或用户不在该群 `allowlist` | `allowChats` / `groupRules.<id>.allowlist` |
| `dm_policy_rejected` | 私聊未放行 | `allowUsers` |
| `group_policy_rejected` | 群策略是 `disabled` / `admin_only` / `blacklist` | `groupPolicy` / `groupRules` |
| `bot_not_mentioned` | 策略要求 @ 但没 @ | 消息里 @ 机器人，或改策略 |

4. **执行了吗** → `feishu.session.created`、`feishu.conv.send_reply_start`；异常看 `feishu.conv.run_error`、`run_idle_timeout`（`phase: tool` 卡在工具，`model` 卡在等模型）、`model_retry`（pi 在自动重试）、`model_quiet`（等模型 1 分钟没输出）。任务还在跑时让用户发 `/progress` 看进度。
5. **回复发出去了吗** → `feishu.outbox.delivered`；失败看 `feishu.outbox.failed` 的 `lastError`。

```bash
grep -E 'feishu\.(pipeline\.drop|conv\.event|conv\.run_error|outbox\.failed)' <日志>
```

## 4. 常见症状速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 桥没起来，日志 `feishu.bridge.autostart_skipped` | `reason: disabled` = 没设 `FEISHU_CHANNEL_ENABLED=1`（默认关）；`reason: mode` = 不是 `pi --mode rpc` | 部署进程设上该变量并用 `--mode rpc`（容器要重建）；本地 TUI 要连就 `/feishu:start` |
| `status.json` 说已连接，却没反应 | 文件过期，进程已停 | 看 mtime，重启 |
| 改了 `config.json` 不生效 | 没 reload / 重启；字段要重启；同名环境变量覆盖 | `/feishu config reload` 看回执；日志 `feishu.config.reloaded` 的 `applied` / `restartRequired`，`reload_failed` 是文件有错 |
| 回复机器人的消息，没 @ 也触发 | 开了 `groupAlsoOnReply`（默认关） | 设为 `false` 后 `/feishu config reload`；是环境变量 `FEISHU_GROUP_ALSO_ON_REPLY` 开的要去掉后重启 |
| 任务被中止（空闲超时） | 工具执行中 `runToolIdleTimeoutMs`（默认 60 分钟）没有输出，或等模型时 `runIdleTimeoutMs`（默认 10 分钟）没有输出 | 中止提示和 `run_idle_timeout` 的 `phase` 说明是哪一种；调大对应字段 |
| 卡片停在「正在处理…」/ 半截，答案另发一条 | 旧版本没处理卡片 10 分钟后流式模式被关闭（`update_failed` 的 `200850` / `300309`） | 升级；新版本记 `feishu.stream_card.streaming_closed` 后改用整组件替换 |
| 显示「模型服务暂时不可用，正在自动重试」/「可能在排队」 | 模型服务繁忙（DeepSeek 排队时只发 keep-alive，pi 的 HTTP 超时拦不住） | 等或 `/stop` 后 `/model` 换模型；常遇到把 `runIdleTimeoutMs` 调到 `180000`。见 [运维 §4](../../docs/operations.md#4-常见症状) |
| 消息上的表情什么意思 | 敲键盘 = 已收下（排队或执行中）；+1 = 已并入当前这一轮；DONE = 完成；❌ = 失败；`/stop` 中止的不留表情 | 看排队用 `/queue list` / `/progress`；改表情用 `reaction.*`，`doneEmoji: ""` 关掉完成表情。见 [运维 §4](../../docs/operations.md#4-常见症状) |
| 群切到全群共用后机器人不记得之前的内容 | 会话 key 从 `<chatId>:u:<openId>` 变成 `<chatId>`，旧个人会话还在；几个人在群里各做各的事时，该群应设 `groupRules.<id>.sessionsPerUser: true` | 群里 `/sessions` 找「某某 的个人会话」，本人或管理员 `/resume #N`（恢复后全群共用）。见 [运维 §4](../../docs/operations.md#4-常见症状) |
| 任务执行中问进度没回应 | 普通消息要等当前工具结束才交给模型 | 发 `/progress`（立即回复，不打断任务） |
| 提问卡发出后模型没等就继续做了 | 现在默认等 60 秒（`clarify.waitMs`）；若是老版本或配成 0 → 模型只能靠提示词。看 `feishu.clarify.wait_timeout` |
| 模型要求等很久但没等那么久 | `waitSeconds` 最多 10 分钟（`clarify.waitMs` 更大时以它为准），且总短于 `runToolIdleTimeoutMs`；看 `feishu.clarify.wait_clamped` |
| 提问卡变成「⏭ 已跳过」 | 用户发了散文（不是编号/选项原文）去说别的事 → 作废提问；日志 `feishu.clarify.skipped` |
| 用户说"我答了但机器人没照做" | 现在编号/选项原文（含 `skip`）都算答案；像选择但无效会回「没听懂…」并保留卡片。看 `feishu.clarify.audit` 的 `answered_text` |
| 提问卡顶部出现「⏳ 已经等了一会儿」 | 等待超时后重绘的提示：卡片仍然有效，点一下就行（只有原子卡会重绘，表单卡不动） |
| 点提问卡片选项提示没有权限 / 已过期 | 作答权限 = 能在这里 @ 机器人；卡片答过一次、有新提问、`/new` 或超过 `clarify.ttlMs`（24 小时）后失效 | 放行这个人（§3），或直接打字回复；看 `feishu.clarify.audit` |
| 开了开通申请，没权限的人找机器人没收到申请卡 | 冷却期内已发过、被「暂不放行」（24 小时）、超出每小时上限，或群策略本身拒绝 | 看 `feishu.access_request.silent` 的 `reason`（`reminded` / `ignored` / `rate_limited`）；急用直接改配置 |
| 开了 `groupAlsoOnReply`，回复机器人仍要 @ | 被回复的消息不在最近 `lastSentCacheSize` 条里，或发于重启前 | 设计如此；@ 机器人即可 |
| 桥没起来，日志 `pi.getAgentDir is not a function` | 扩展版本过旧 | 升级扩展；临时设 `FEISHU_CHANNEL_HOME` |
| 连接反复断开又连上 | 同一应用被多个进程连接 | 一个应用只能有一个实例；锁冲突时启动报 `bridge already running for appId …` |
| 每开一个会话多一条 `ws_ready` | 子会话没剔除本扩展 | `feishu.session.resource_loader_ready` 的 `strippedGateways` 应为 1 |
| 审批卡没弹，命令直接执行 | 审批模式是关闭（默认）；用 pi-permission-system 时没配「询问」规则；或内置分级判为只读 | 查 `/feishu approvals` 的模式和来源、PS 规则 |
| 审批已关闭，仍有调用被拒 | 装了 pi-permission-system，不受本扩展模式影响 | 卸插件或在它的配置里放行 |
| 审批卡点不动 | 点的人不是管理员（协作者里的开发者、运营不算） | 加进 `admins`，或由归属人 / 应用管理员点 |
| 点过「始终批准」后再也不弹卡 | 规则表里有这条规则名（`/feishu always` 查看）；PS 用 `*` 作默认规则时，通配规则名**不会落盘**，只在当个会话有效 | 撤销：`/feishu always revoke <规则名>`；切回本会话级授权需要 `/new` |
| 归属人 / 应用管理员没被识别 | 缺 `application:application:readonly` 或协作者接口失败 | 看 `feishu.config.app_owner_hydrated` / `*_hydrate_failed`；开权限后重启，或写进 `admins` |
| 群里 @ 机器人完全没反应，日志只有 `reason: bot_not_mentioned` | 取不到 bot open_id（`feishu.transport.bot_identity_missing`）→ 任何 @ 都判不出「是 @ 我」 | 配 `config.botOpenId`，或恢复应用信息读取权限 |
| 长回答只到了一部分，末尾说「内容可能不完整」 | 某一段（分片）永久失败，其它段照常发出 | 按提示重发这一句；`feishu.outbox.failed` 里的 `lastError` 说明原因 |
| 点卡片提示「已失效」 | 超时（默认 5 分钟）或这一轮已结束 | 尽快点；或调大 `approval.timeoutMs` |
| PS 的「询问」全被拒绝，不弹卡 | PS 的 `authorizerChain` 没写 `feishu-channel`，或 PS 版本 < 27.0.0 | `/feishu doctor` 的 `ps_link`；在 PS 配置加 `"authorizerChain": ["feishu-channel"]` 后重启 |
| 读写工作目录外的文件总被拒，不弹卡 | PS 不允许授权链放行路径类请求 | 日志 `feishu.approval.ps_link_capped`；在 PS 配置里放行这些路径 |
| 回复半截 / 「回复发送失败」 | 编辑次数用尽、无发言权限、接口报错 | `feishu.outbox.failed` 的 `lastError` |
| 页脚费用「未知」 | 模型配置没有费率 | 在 pi 模型配置里补 `cost` |
| 日志 `feishu.config.deprecated_env` | 用了旧环境变量 `FEISHU_BRIDGE_*` | 改成日志里的 `replacement` |
| 日志 `feishu.config.migrate_failed` | 旧目录 `feishu-bridge/` 改名失败 | 按日志 `from` / `to` 手动 `mv` 后重启 |
| 装了新技能 / 扩展，会话里用不上 | 已建立的会话不自动重载 | 在该会话发 `/reload`（或 `/new`）；看回执的新增技能和加载问题，日志 `feishu.conv.reloaded` |
| 日志时间差 8 小时 | `docker logs --timestamps` 恒为 UTC | 换算时区 |

## 5. 改动后的验收

本地测试通过不等于可用。`npm test` 不在部署环境跑（pi 装扩展不带开发依赖，没有 tsx，不要补装）。依次确认：

1. 重启后日志出现 `bridge started`（出现 `feishu.bridge.autostart_skipped` 就按 `reason` 查：没设 `FEISHU_CHANNEL_ENABLED=1` 或不是 `--mode rpc`）；
2. `status.json` mtime 在 90 秒内，`connState` 为 `connected`；
3. `feishu.bridge.features` 与预期一致；
4. 在测试群 @ 机器人，发**会调用工具**的消息，例如「用 bash 执行 `echo SMOKE-1`，把输出原样告诉我」（知识问答不会触发工具，测不到审批）；
5. 需要审批时由**管理员本人**点卡片（webhook 能触发对话，但不是管理员，点不了）；
6. **以最终效果为准**：回复里出现 `SMOKE-1`。

## 6. 不要这样做

- **不要在运行中的实例旁再起一个 pi**（包括 `pi -p`）：会抢同一应用的连接，还会把 `status.json` 写成断开。隔离测试时给新进程独立的 `PI_CODING_AGENT_DIR` 和 `FEISHU_CHANNEL_HOME`。
- **不要用机器人自己的身份发测试消息**：会被当作自身回声过滤。
- **不要用 `/proc/<pid>/environ` 查运行时环境变量**：那是启动时的快照。
- **不要把 `appSecret`、真实 open_id / 群 id 写进公开仓库或贴到群里。**
