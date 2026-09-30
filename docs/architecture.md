# 架构

本文说明 pi-feishu-channel 的组成、一条消息的完整路径，以及系统承诺遵守的不变量。
运行时怎么观察这些环节，见 [operations.md](operations.md)。

## 1. 定位

pi-feishu-channel 是一个 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 扩展。它把 pi 编码助手接入飞书 / Lark 的群聊和私聊，面向**团队共用**的场景：

- **按会话隔离**：每个群、话题或私聊都有独立的 agent 会话和执行队列；群里也可以按人再隔离。
- **治理**：群策略、准入白名单、管理员审批工具调用、按群预算与用量统计、开通申请。
- **可靠性优先**：消息不丢、执行不串、回复必达，这三点排在流式渲染、卡片等体验能力之前。

## 2. 模块分层

```
src/
  types.ts  pi-types.ts  config.ts  config/     核心类型与配置
  runtime/     单实例锁、状态文件、重连监管、限流熔断、诊断、用量账本、定时任务、告警
  inbound/     飞书长连接、消息规整、准入、去重与合批、入站流水线
  outbound/    错误归一化、长文分片、发送、流式通道、持久化 outbox、页脚指标
  approval/    权限桥、命令分级、审批卡、pi-permission-system 父会话转发
  session/     pi 会话后端、会话管理器、调度、单轮执行、进度、会话指针
  commands/    命令注册表、状态与帮助卡片
  interaction/ 澄清提问、卡片回调鉴权
  index.ts     扩展入口：装配以上组件，向 pi 注册命令与事件
```

依赖方向自上而下：`types` / `config` 不依赖任何模块；`session` 依赖 `inbound`、`outbound`、`runtime`；只有 `index.ts` 依赖全部模块。
扩展入口正在拆分，目标结构见 [development/refactor-plan.md](development/refactor-plan.md) §7。

## 3. 一条消息的路径

```
飞书 WS 事件
  │  inbound/transport       解析事件；立即 ACK，按 chat 串行在后台处理
  ▼
入站流水线 inbound/pipeline
  │  1. 去重（dedupe-store）       平台重投的同一 message_id 只处理一次
  │  2. 合批（pipeline-utils）     短时间内的连续消息合成一轮
  │  3. 准入（admit）              群策略 / 白名单 / @ 判定 / bot 过滤 —— 除去重外唯一的丢弃点
  │  4. 接管账本（pending-store）  先持久化，再派发：崩溃后可以重放
  │  5. 回复解析                   拉取被回复消息的原文
  ▼
会话管理 session/conversation-manager
  │  conversationKey → 独立 agent 会话 + 队列；同一个 key 同时最多一轮在执行
  │  忙碌时：新消息并入当前轮（steer）或排队
  ▼
单轮执行 session/run-executor
  │  pi agent 执行；工具调用经过审批闸门（approval/）
  │  进度消息、流式卡片走易失通道（outbound/live-channel、streaming-card）
  ▼
最终回复 outbound/outbox → sender
  │  先写入持久化 outbox，再发送；失败按错误类别重试、降级或回退
  ▼
飞书
```

## 4. 不变量

下面每一条都有测试覆盖。改动相关代码时，先找到对应的测试。

| # | 不变量 | 主要实现 | 主要测试 |
|---|---|---|---|
| 1 | **先持久化后确认**：入站消息进入内存批次前先写接管账本；最终回复先写 outbox 再发送 | `pending-store`、`outbox` | `intake-persistence`、`outbox` |
| 2 | **一个会话键**：合批、会话、outbox 通道、审批都使用同一个 `conversationKey` | `conversation-key` | `conversation-manager` |
| 3 | **同 key 串行**：一个会话同时最多一轮在执行；超时的轮次被取消后，下一轮才能开始 | `scheduler`、`run-executor` | `scheduler`、`scheduler-fairness` |
| 4 | **易失通道不承载正确性**：流式编辑失败不影响最终回复；最终回复由 outbox 对账 | `live-channel`、`streaming-card` | `live-final-ordering`、`streaming-card` |
| 5 | **ID 优先**：@ 判定两侧都有同层 ID 时，ID 不同即不匹配，不能再用名字翻案 | `normalize` | `normalize`、`admit` |
| 6 | **不静默丢弃**：除去重和准入外，所有拒绝、溢出和永久失败都记录原因和关联 ID | 各模块日志 | `pipeline`、`outbox` |
| 7 | **审批跟随执行**：一轮结束或会话重置时，未决审批立即失效，旧卡片不能再授予权限 | `permission-bridge` | `permission-run-lifecycle` |
| 8 | **失败即关闭**：白名单为空表示全部拒绝；没有管理员时审批卡无人可点 | `admit`、`permission-bridge` | `admit`、`permission-bridge` |

## 5. 会话模型

| 场景 | conversationKey | 说明 |
|---|---|---|
| 私聊 | `<chatId>` | 一人一会话 |
| 群聊（默认按人隔离） | `<chatId>:u:<openId>` | 同一个群里每人一份上下文 |
| 群聊（共享） | `<chatId>` | `groupSessionsPerUser: false` |
| 话题 | `<chatId>:t:<threadId>` | 话题内共享，不同话题互不影响 |

会话指针（`conversations.jsonl`）记录每个 key 当前的会话文件。`/new` 先写指针再切换运行态，所以重启后不会回到旧上下文。

## 6. 审批

工具调用有三道关，依次判定：

1. **pi-permission-system**（如果安装了，并且 `approval.policyEngine` 让权给它）：它的 `tool_call` 闸门先于本扩展执行。它判定 deny 时直接拦截；判定 ask 时，可以通过**父会话转发**把请求变成飞书审批卡。
2. **命令分级**（内置策略）：只读命令免审，危险命令直接拒绝，其余需要审批。
3. **审批卡**：发给会话，只有管理员（显式配置的管理员 + 应用归属人 / 协作者）能点。选项有「批准一次 / 本会话批准 / 始终批准 / 拒绝」；超时按拒绝处理。

## 7. 与 pi 的边界

- 只使用 pi 官方导出的 API；本地类型声明（`src/pi-types.ts`）保持独立的类型检查。
- 每个会话是一个独立的 pi 子会话。子会话加载扩展时会剔除本扩展，否则每个子会话都会再启动一个飞书长连接；同时注入一个内联扩展，提供审批闸门和文件、通知、提问工具。
