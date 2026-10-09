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
2. **在哪运行**：本机进程还是容器。容器里的命令要加 `docker exec <容器名>` 前缀，日志用 `docker logs`。
3. **你自己是不是跑在这个扩展里**（即当前对话来自飞书）：是的话，**不要重启、kill 或另起 pi 进程** —— 会中断自己所在的进程或抢占连接。把要执行的命令交给管理员。

## 1. 改配置

- 编辑 `<home>/feishu-channel/config.json`，**改完要重启进程才生效**（没有热加载）。
- 启动时校验：类型或取值错误会拒绝启动，并一次列出全部问题；**拼错的字段不报错**，用 `/feishu doctor` 的 `config_fields` 项检查。
- **环境变量优先于配置文件**。改了文件不生效时，先查是不是有同名环境变量（如 `FEISHU_GROUP_POLICY`、`FEISHU_ALLOW_CHATS`）在覆盖。
- 凭据（`appId` / `appSecret`）建议走环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，不要写进文件，也**不要在回复或日志里输出 secret**。
- 运行中的进程会把部分字段写回文件：`/feishu policy`、`/feishu footer`、群开通审批（`allowChats`）、「始终批准」（`approval.autoApprove`）等。
  进程会用内存里的值覆盖这些字段，所以**手改同名字段后要立即重启**，别和运行中的命令交叉修改。
- 能用飞书命令改的优先用命令（即时生效，自动写回）：`/feishu policy <策略>`、`/feishu footer on|off`、`/feishu prompt set <内容>`、`/feishu budget <美元>|off`、`/feishu always revoke <规则名>`。多数只有管理员能用。

### 准入是默认拒绝的

| 想要 | 改什么 |
|---|---|
| 让某个群能用 | 把群 id（`oc_` 开头）加进 `allowChats`。**空数组 = 拒绝所有群** |
| 让某人能私聊 | 把 open_id（`ou_` 开头）加进 `allowUsers`。**空数组 = 拒绝所有私聊**；管理员和应用归属人始终可以 |
| 群里不 @ 也响应 | `groupPolicy` / `groupRules.<群id>.policy` 设为 `open` |
| 只让部分人在某群使用 | `groupRules.<群id>.policy: "allowlist"` + `allowlist` |
| 让其它机器人 / webhook 触发 | `allowBots` 加 `"mentions"`（任何 @ 了本机器人的 bot 都放行，不依赖 id，换应用不失效）；或加对方 `app_id` |
| 指定管理员 | `admins`（open_id）。应用归属人和协作者启动时自动识别，**不用写** |
| 限制某群可用的工具 | `groupRules.<群id>.tools`：`readonly` / `standard` / `full` / 工具名数组 |

open_id 是**按应用生成**的：换了飞书应用，`admins`、`allowUsers`、`groupRules` 里的 open_id 和 `allowBots` 里的机器人 open_id 全部要重新确认。

### 可选能力默认关闭

`streamingCard`、`cron`、`alerts`、`directBash`、`longReply`、`docComments`、`docTools`、`cardTool`、`meetingInvite`、`stt`、`onboarding.accessRequest`、`approval.forwarding` 都需要显式开启。
当前开了哪些：启动日志 `feishu.bridge.features`、`status.json` 的 `features` 字段、`/feishu doctor`。

## 2. 健康检查

```bash
H="${FEISHU_CHANNEL_HOME:-$HOME/.pi/agent}/feishu-channel"
stat -c 'mtime: %y' "$H/status.json"; date '+now:   %F %T'
cat "$H/status.json"
```

- **先看 mtime**：进程每 30 秒刷新一次，**mtime 距今超过 90 秒 = 进程已停**，这时文件里的 `connState: "connected"` 是过期数据。
- 再看：`connState`、`reconnectsLast5m`（持续偏高 = 抖动）、`sessionQueues.waiting`（持续 > 0 = 并发不够）、`pendingApprovals`、`outbox.failed` / `oldestAgeMs`、`messageDropped`。
- 配置和权限问题：在飞书里发 `/feishu doctor`，每项给出 `ok` 或具体问题。

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

4. **执行了吗** → `feishu.session.created`、`feishu.conv.send_reply_start`；异常看 `feishu.conv.run_error`、`run_idle_timeout`。
5. **回复发出去了吗** → `feishu.outbox.delivered`；失败看 `feishu.outbox.failed` 的 `lastError`。

```bash
grep -E 'feishu\.(pipeline\.drop|conv\.event|conv\.run_error|outbox\.failed)' <日志>
```

## 4. 常见症状速查

| 症状 | 原因 | 处理 |
|---|---|---|
| `status.json` 说已连接，却没反应 | 文件过期，进程已停 | 看 mtime，重启 |
| 连接反复断开又连上 | 同一应用被多个进程连接 | 一个应用只能有一个实例；锁冲突时启动报 `bridge already running for appId …` |
| 每开一个会话多一条 `ws_ready` | 子会话没剔除本扩展 | `feishu.session.resource_loader_ready` 的 `strippedGateways` 应为 1 |
| 审批卡没弹，命令直接执行 | 用 pi-permission-system 时没配「询问」规则；或内置分级判为只读 | 查 `/feishu approvals`、PS 规则 |
| 审批卡点不动 | 点的人不是管理员 | 加进 `admins`，或由归属人点 |
| 点卡片提示「已失效」 | 超时（默认 5 分钟）或这一轮已结束 | 尽快点；或调大 `approval.timeoutMs` |
| PS 的「询问」全被拒绝 | 没开转发 | `approval.policyEngine: "pi-permission-system"` 与 `approval.forwarding.enabled: true` **一起开** |
| 回复半截 / 「回复发送失败」 | 编辑次数用尽、无发言权限、接口报错 | `feishu.outbox.failed` 的 `lastError` |
| 页脚费用「未知」 | 模型配置没有费率 | 在 pi 模型配置里补 `cost` |
| 日志 `feishu.config.deprecated_env` | 用了旧环境变量 `FEISHU_BRIDGE_*` | 改成日志里的 `replacement` |
| 日志 `feishu.config.migrate_failed` | 旧目录 `feishu-bridge/` 改名失败 | 按日志 `from` / `to` 手动 `mv` 后重启 |
| 日志时间差 8 小时 | `docker logs --timestamps` 恒为 UTC | 换算时区 |

## 5. 改动后的验收

本地测试通过不等于可用。依次确认：

1. 重启后日志出现 `bridge started`；
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
