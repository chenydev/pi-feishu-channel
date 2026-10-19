# `feishu_ask` 的交互形态：调研与建议

> 状态：**设计调研**（未实施）。结论在第 5 节，决策点在最后一节。
> 适用版本：0.3.2（`feishu_ask` 目前完全异步）。

## 1. 问题

现在 `feishu_ask` 是**纯异步**的：

1. 模型调工具 → 立刻返回 `{ status: "card" }`（不含答案）；
2. 模型这一轮结束；
3. 用户点卡片 → 桥把一条**新的用户消息** `[选择] …` 推进会话，开启新一轮。

于是出现两个问题：

- **模型不知道它是异步的**：工具描述只写「会变成卡片」，模型容易问完继续往下做，把"等用户回答"当成了"已经问过"。
- **没有"等一会儿"的能力**：多数时候用户就在手机上，10–60 秒就会点。这段时间 agent 已经收尾，答案变成"一条新消息"，模型往往**重新规划**——用户点了答案，得到的是一次新的思考，而不是接着刚才那件事做。

## 2. 业界的两种规范形态

| 形态 | 代表实现 | 行为 | 主要代价 |
|---|---|---|---|
| **A. 阻塞 + 超时** | Claude Code `AskUserQuestion`（**60 秒**超时，之后报 "No response after 60s — continued without an answer"）；LangGraph `decisions.ask()`（默认 900 秒，可配 30–3600）；Temporal Signal + durable timer；**本仓库的审批卡**（默认 300 秒，超时视为拒绝，>90 秒会提醒） | 工具调用挂起，等到答案就地返回；超时给"没等到"的明确结果 | 会话在等待期间是"忙"的；重启丢失等待；长等待占住 run |
| **B. 中断 + 可恢复** | LangGraph `interrupt()`（需要 checkpointer，恢复用 `Command(resume=...)`）；OpenAI Agents SDK（待批准项以 `interruptions` 返回，`RunState` 可序列化后恢复）；Temporal "resumable activity"（活动耗尽重试后挂起，等人 Signal 再继续） | run 结束并落盘"待输入"状态，答案到达时**恢复** | 需要持久化的中断状态与恢复路径；恢复时的上下文一致性要自己保证 |
| **C. 纯异步（本项目现状）** | —— | 答案作为一条新用户消息进入会话 | 模型必须靠提示词约束；答案到达时是新指令，容易被重新规划 |

### 平台侧的硬约束（影响的是"卡片回调"，不是工具等待）

| 平台 | 约束 |
|---|---|
| Slack | 交互回调必须 **3 秒内** ack，之后可异步更新消息 |
| Discord | 3 秒内首次响应；交互 token **15 分钟**内有效 |
| 飞书 | 回调失败会重试（一周内失败 4 次才通知开发者）；因此回调必须快速返回，重活要异步做（本项目已经是 `void` 异步路由 + 回调里返回新卡） |

结论：**平台约束不支持"在回调里长时间阻塞"**，但支持"在工具里等待"——两者是不同层面，不冲突。

## 3. 本项目为什么不能照搬

桥是**群里的一个成员**，不是一个等待 RPC 的后端：

1. **用户可能几小时后才看手机**：纯阻塞会让会话"忙"几小时，期间新消息只能排队。所以不能只有 A。
2. **阻塞期间的影响面是具体的**（都能在代码里定位）：
   - `activeRun = true` → 新消息走 steer / 排队（`busyReason` 拒绝改历史的命令）；
   - `/progress` 会显示「在等模型回复」——**错的**，应该说「等你作答」；
   - 流式卡片一直开着（烧编辑配额）；
   - `isQuiet()` 只认 `pendingApprovalCount`，**不认待答提问** → 走 B 形态时，会话可能在用户作答前被空闲回收（指针还在，但句柄重建）；
   - `/stop` 必须能打断等待（pi 的 `ctx.signal` 可用）；
   - 重启：等待的 Promise 消失，卡片还在 → 需要退化路径（现状天然支持，因为答案本来就是一条消息）。
3. **三个交互面目前是两种语义**：审批卡（阻塞 300 秒）、pi TUI 的 `ask_user_question`（阻塞）、`feishu_ask`（异步）。同一套系统里"问用户"应该有统一心智。

## 4. 三个候选方案

### 方案 1：只修契约（10 分钟）

工具描述写清：异步、答案以 `[选择]` 消息到达、问完不要假设答案。
**优点**：零风险，立刻减少"问完瞎跑"。
**缺点**：不解决"用户就在旁边却要重新规划"。

### 方案 2：契约 + 有界等待（推荐，约半天）

```ts
feishu_ask({ question, options, waitSeconds?: number })  // 默认 60，0 = 纯异步，上限 300
```

三种结局都是**工具结果**：

| 结局 | 返回 | 模型应该做什么 |
|---|---|---|
| 等到答案 | `{status:"answered", answers:[{question, choices, other}]}` | 同一轮继续 |
| 超时 | `{status:"pending", hint:"用户还没答；答案会以 [选择] 消息到达。不要重复提问；可以先说明你打算怎么继续"}` | 说明默认策略，或停下 |
| 中止（`/stop`、桥关闭） | `{status:"cancelled"}` | 停 |

卡片保留现状（TTL 24 小时）。超时之后用户再点 → 仍是 `[选择]` 新消息，但前缀加「（补充作答，之前已超时）」，避免模型把它当成新指令重复动作。

**为什么 60 秒**：Claude Code 的 `AskUserQuestion` 用的就是这个值；再长就不是"等着"而是"挂起"了。可配置，便于各团队按自己的响应速度调。

### 方案 3：完整可恢复（方案 2 + 持久中断状态，约 2–3 天）

在方案 2 的基础上把"待作答"做成一等状态：`ClarificationStore` 记录 `answeredAt/source/attempts`；恢复时不依赖进程内 Promise（重启后点卡片也能"接上"原 run，而不是开新轮）。
**优点**：最接近 LangGraph / OpenAI Agents SDK 的形态，跨重启语义正确。
**缺点**：要处理恢复时的上下文一致性（原 run 早已结束，靠什么"接着做"？本质上还是发一条新消息）+ `isQuiet`、`status.json`、`/progress` 全套联动。对聊天场景收益有限。

## 5. 超时之后的策略（可配）

「等多久」和「等不到怎么办」是两件事。后者比前者更需要判断，因为它是**替用户做决定**。

| 策略 | 工具返回 | 用户看到 | 风险 | 适用 |
|---|---|---|---|---|
| **`wait`（默认）** | `{status:"pending"}` | 卡片仍在，模型说「等你回答」 | 任务停着 | 通用 |
| `recommend` | `{status:"timeout", assumed:"⭐X"}` | 模型明说「等 N 秒没回，先按推荐项 X 做」 | 猜错方向白做一轮 | 有推荐项、做错代价小 |
| `default` | `{status:"timeout", assumed:"指定的 fallback 项"}` | 同上 | 同上 | 选项里有天然默认（如「保持现状」） |
| `abort` | `{status:"abandoned"}` | 「没等到回答，这次先停」 | 用户要重新发起 | 不该猜的操作（改配置、删数据） |
| `ask_again` | 再提醒一次，再等一轮 | 收到一次提醒 | 容易刷屏 → **最多 1 次** | 群里决策人忙、可能漏看 |

```json
"clarify": {
  "waitMs": 60000,          // 工具等多久（0 = 纯异步）
  "onTimeout": "wait",      // wait | recommend | default | abort | ask_again
  "remindAfterMs": 300000   // 仅 ask_again：超时后多久提醒一次
}
```

每条提问还可按次覆盖（`feishu_ask({..., onTimeout: "abort"})`）：删数据这类单独从严，不用改全局。

**三条硬规则**：

1. **默认不替用户决定。** 模型猜错的成本通常高于「多等一会儿」，所以 `wait` 做默认。
2. **只要替用户做了选择，就必须说出来。** `recommend` / `default` 生效时，回复里必须有
   「等 N 秒没回，我先按 **X** 继续；要改直接说」。静默的「替你决定」是这类系统里最伤信任的失败模式。
3. **之后用户真答了，要能改。** 超时后点卡片仍走 `[选择]` 消息，但带标记：
   `（补充作答：之前超时了，当时按「测试环境」继续）`。

`recommend` 需要真的有推荐项：模型没给 `recommended` 时**自动退化为 `wait`** —— 不能拿「第一个选项」冒充推荐。

## 6. 用户想「继续」时怎么办

先澄清一个常见误解：`wait` 模式下**不存在一直挂起的 run**。60 秒到了工具就返回 `{status:"pending"}`，
这一轮结束——没有阻塞的进程、没有占着的锁，只剩「一条待答记录 + 一张卡片」。所以「继续」是
一条普通新消息，**不是去解一个卡住的 state，不需要 `/stop`**。

| 用户怎么做 | 系统怎么理解 | 结果 |
|---|---|---|
| 点卡片作答 | `[选择] X` | 新一轮，模型接着做（卡片 TTL 24 小时，隔天点也认） |
| 直接说别的 /「你定」 | 普通新消息 | 隐式放弃提问，模型按自己的判断继续 |
| 什么都不做 | 没反应 | 会话照常空闲，卡片过期失效，不消耗资源 |
| `/stop`（仅在 60 秒等待期内） | 打断等待 | 工具返回 `{status:"cancelled"}`，卡片转「已取消」 |

### 状态机

```
发问 → pending
        ├─ 点卡片          → answered  （新消息 [选择] X）
        ├─ 用户发别的消息  → skipped   （卡片转「已跳过」）
        ├─ /stop（等待期内）→ cancelled （卡片转「已取消」）
        ├─ 另一提问覆盖    → superseded（已有逻辑）
        └─ 24h 无人理      → expired   （已有逻辑，卡片点不动）
```

### 必须补的三处，否则体验会烂

1. **新消息 = 隐式跳过**：用户说了别的，卡片就该转「已跳过」。否则三天后误点那张卡，
   一个过时答案会插进当前对话，被模型当成现在的指令执行。
2. **模型得知道有待答提问**：下一轮用户消息前注入一行（`（你之前的问题「X」还没回答，用户现在说：…）`），
   或者在 `/feishu status` 里显示「1 个待答提问」。
3. **`/stop` 的提示要分清**：等待期内 → 打断；等待期外 → 「没有执行中的任务。有一个待答提问，
   可以直接作答，或发新消息跳过它」。

### 会话回收：别把 TTL 当保护期

如果让 `isQuiet()` 认「待答提问」，会话会被保护 **24 小时**，空闲会话永远回收不了。
正确做法：待答提问只保护一个**短窗口**（发问后 15 分钟内），之后会话照常回收 ——
记录和卡片是持久的，用户之后点卡片仍能用（会话按指针重建）。

## 7. 建议

**做方案 2**（`waitMs` 默认 60 秒，`onTimeout` 默认 `wait`），并顺手补四处一致性：

1. `ClarificationRecord` 增加 `skipped` / `cancelled` 状态与对应卡片（复用只读卡，文案换掉）；
2. 入站路由入口：有新消息就跳过待答提问（隐式跳过，见第 6 节）；
3. `isQuiet()` 用**短窗口**（15 分钟）认待答提问，避免等待中的会话被回收，又不至于让空闲会话永远回收不了；
4. `/progress` 与 `status.json`：有待答提问时显示「等你作答」，而不是「在等模型回复」。

默认值按团队习惯用 `clarify.waitMs` 调，不改代码。

**不做方案 3 的理由**：它的核心价值是"跨重启恢复原 run"，但原 run 已经结束，恢复实际上还是要起新一轮——那和方案 2 的超时路径等价，只是多了一套状态机。等真出现"必须接着原来那轮继续"的需求（例如长流程中间点）再上。

**可选增强（先不做）**：按用户活跃度自适应等待 —— 用户最近 5 分钟发过消息就等 60 秒，否则只等 15 秒。逻辑简单但要先有数据支撑（见下）。

## 8. 实施清单（方案 2）

| 文件 | 改动 | 量 |
|---|---|---|
| `src/interaction/clarification-store.ts` | `waitForAnswer(id, ms)`（基于现有 `decide()`）；记录加 `answeredAt` / `answeredAfterWait` | 小 |
| `src/runtime/assemble.ts` | 发卡后按 `waitSeconds` 等待，三种结局返回 | 小 |
| `src/session/pi-bridge-hooks.ts` | 参数 `waitSeconds` + 描述改写（含三种返回与"问完不要假设答案"） | 小 |
| `src/session/conversation-manager.ts` | `isQuiet` 认待答提问；`progressReport` 显示「等你作答」 | 小 |
| `src/config/schema.ts` | `clarify.waitMs`（默认 60000） | 小 |
| `tests/` | 4 个场景：等到 / 超时 / 中止 / 超时后补答 | 中 |
| `docs/` + `CHANGELOG.md` | 审批-提问的语义对照、`/stop` 行为 | 小 |

验证方式：`npm run check` + 真机一次（发卡 → 60 秒内点 → 看模型是否在同一轮继续；再发一张不点，看超时提示）。

## 9. 上线后要看的数

- **超时率**：> 30% 说明等待值太短或用户不在手机旁，考虑调 `clarify.waitMs` 或上自适应；
- **平均作答耗时**：决定默认值该是 60 还是 120；
- **`pending` 之后是否重复提问**：这是提示词是否写清楚的最直接指标。

## 参考

- Claude Code 用户输入与 60 秒超时：<https://code.claude.com/docs/en/agent-sdk/user-input>
- OpenAI Agents SDK（interruptions / RunState）：<https://openai.github.io/openai-agents-python/human_in_the_loop/>
- LangGraph interrupts（checkpointer + `Command(resume=...)`）：<https://docs.langchain.com/oss/python/langgraph/interrupts>
- Temporal approval pattern（Signal + durable timer）：<https://docs.temporal.io/design-patterns/approval>
- Slack 3 秒 ack：<https://github.com/slackapi/bolt-js/issues/1504>
- 飞书事件回调重试策略：<https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-callback-optimization-guide>
