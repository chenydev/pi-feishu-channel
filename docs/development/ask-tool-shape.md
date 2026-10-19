# `feishu_ask` 的交互形态：调研与建议

> 状态：**已实施第一版**（未发布）：`waitMs` 默认 60 秒、`onTimeout` 支持 `wait`/`abort`、
> 超时后不替用户选择、隐式跳过（`skipped`）。`recommend` / `ask_again` 仍未做。
> §10–§11 是与 hermes 最新实现的对照（含「该抄什么、不该抄什么」）。
> §11 的三条建议已落地：打字回复三分法、超时后「等待已结束」卡片、移除 `onTimeout: "abort"`。
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

## 10. 参考实现：hermes 的 `clarify`（2026-10-18 最新版）

> **版本核对**：本地 clone `~/dev/projects/quanbu/basic/hermes-agent` 在 `merge/zj-upstream-20260716`
> （2026-07-16），基于 `upstream/main` 2026-07-15 的 `f8b6d381e`。真实远端 main 头是
> `08a91ad2ab`（2026-10-18），`tools/clarify_gateway.py` 与 `tools/clarify_tool.py` 相对那份旧代码分别
> 改了 445 / 322 行，并新增了 `gateway/session_clarify_batch.py`、`gateway/run_turn_runner_clarify_delivery.py`
> 和桌面端 clarify UI。**下文全部基于 `08a91ad2ab`。**

### 10.1 形态：阻塞 + 可配超时（默认 1 小时）

```python
# tools/clarify_gateway.py
def resolve_clarify_timeout(config) -> int:
    raw = (config.get("clarify") or {}).get("timeout")          # legacy
    if raw is None: raw = (config.get("agent") or {}).get("clarify_timeout", 3600)
    return int(raw)                                              # <= 0 = 无限
```

源码注释记录了为什么是 3600 而不是 600：早期默认 600 秒会在用户思考期间把条目清掉，于是
「晚点的点击落到死条目上，agent 卡在 `running: clarify`」（#32762）。取舍原话：够长让离开的用户回来还能点，
够短让被放弃的提问最终释放 running-agent guard。

`wait_for_response` 用 **1 秒切片**轮询 `threading.Event`，每片 `touch_activity_if_due(...)` ——
一次长 `Event.wait` 会让 gateway 的 inactivity watchdog 在用户还在打字时把 agent 杀掉（#10807）。

### 10.2 超时 → **卡片必须退役**

```python
# gateway/run_turn_runner.py :: _ask_clarify_question
if not answered:
    retire = getattr(type(ctx._status_adapter), "retire_clarify_card", None)
    if callable(retire):
        self._schedule(retire(ctx._status_adapter, clarify_id, _clarify_expired_notice()))
```

文案：`⏳ This prompt expired — please send a new request.`

**这是他们和我们最根本的差异**：hermes 是线程阻塞等待，超时后 agent 线程已经跑了，答案**无处可去** ——
留一张还能点的卡只会出现「点了没人接」，所以他们必须退役，还专门写了 `_notify_clarify_expired`
（「⚠️ This prompt expired — please /retry」）。

我们的等待是「可选的一次等待」：超时后记录还在、卡片还能点，答案仍然有一条合法路径（新消息进会话）。
所以**保留比退役更有价值** —— `skipped` 和「补充作答」两套语义都建立在"记录还在"上。

代价是：卡片看起来仍像"在等你"，用户不知道等待已经结束。这点该补（见 §10.6）。

### 10.3 结果形状：一个 JSON，四种结局

```jsonc
{
  "responses": [{"question": "...", "choices_offered": ["a","b"],
                 "status": "answered|skipped|unanswered", "user_response": "b" | null}],
  "outcome": "submitted|timed_out|cancelled|undelivered",
  "notice": "[user did not respond within 60m]"     // 超时/投递失败的人话原因
}
```

要点：**超时不引入新结构**，只是 `status: "unanswered"` + `outcome: "timed_out"` + `notice`。
`notice` 存在的理由写得很明确：只有空答案会把「投递失败」误报成「用户不理」（#112684）。

### 10.4 不替用户决定

全库没有 recommend / default / assume 分支：超时就是 unanswered。推荐的表达只在展示层：
`mark_recommended()` 把**第一个**选项后缀 `(Recommended)`（schema 约定 best-first），
答复时 `strip_recommended()` 剥掉，保证展示不进 `user_response`。

### 10.5 打字回复：三种结局分开处理（最值得抄）

```python
# gateway/run_inbound.py
_text_outcome = attempt_text_response_for_session(session_key, text)
# TEXT_RESOLVED           数字 / 完全匹配选项文本 → 当答案，作废卡片按钮
# TEXT_REJECTED_SELECTION 选择形状但无效（"9"、错误逗号列表）→ 保留提问，等用户重试
# TEXT_REJECTED_PROSE     自然语言散文 → 先 CANCELLED 解掉等待，退役卡片，再走正常路由
```

注释点明散文为什么必须先解除等待：`redirect()` 在工具执行期间退化为 `steer()`，而那个 steer
**要等 clarify 工具返回才能排空** —— 不先解除就死锁。斜杠命令不算答案（保留 pending）。

### 10.6 其它细节

| 点 | hermes 的做法 |
|---|---|
| 多题（消息平台） | **一题一张卡，串行**；第一题没答就停。本地 CLI/TUI 才用一次性面板 |
| 多题（上限） | 5 题；每题 4 个选项 + 自动追加 `Other / type answer` 行 |
| 多选 | 支持；文本 `1,3` / `1 3` / 标签解析成 JSON 数组，任一项无效则整条拒绝 |
| 跳过单题 | 文本 `skip` → `status: "skipped"`；消息平台卡上带提示 `Reply "skip" to skip this question.` |
| `/stop` | `is_interrupted()` 在 1 秒切片里检查 → `CANCELLED`，不白等超时 |
| `/new`、关闭、缓存淘汰 | `clear_session()` 批量取消；**首次写入获胜**（已 set 的真实答案不被覆盖） |
| 投递失败 | 专门 sentinel `[clarify prompt could not be delivered]`（含 declined / 无会话三种），并发一次纯文本兜底；**只有确定性失败才拆注册**，发送超 15 秒未确认算 `ambiguous`，继续等待 |
| 可观测 | `human_input_request` 观察者只拿问题，**不拿答案** |

## 11. 对照我们的实现：该抄什么、不该抄什么

| 我们现在的做法 | hermes | 结论 |
|---|---|---|
| 默认等 60 秒，超时保留记录 + 卡片可点 | 默认等 3600 秒，超时退役卡片 | **保留我们的**：长等待会占住会话（15 分钟保护窗口 + 流式卡 + `/progress`），60 秒换更快反馈；卡片继续可点是我们的优势 |
| 超时后卡片**没有任何可见变化** | 退役并把文案改成「已过期」 | **要补**：卡片头部改成「⏳ 等待已结束，仍可作答」——不误导、又不作废 |
| 下一条消息一律「跳过」提问 | 三分法：答案是答案 / 无效选择重试 / 散文才取消 | **要抄**：现在用户直接打字回答会被当成"跳过"，他以为自己答了 |
| 超时 → `{status:"pending"}`，模型收到中文说明 | 超时 → 同形状 + `outcome` + `notice` | 我们的可读性更好，但**可考虑加 `notice`** 供日志/卡片复用 |
| ~~`abort` 策略作废记录~~（已移除） | 无对应概念（内部就是退役卡片） | **已删掉**：有了「等待已结束」卡片，作废记录的唯一收益（卡片失效）已由视觉解决，而它的四个坑（文案、失败计数、模型重问、重启不一致）还在 |
| 一张表单卡多题（一次提交） | 一题一张卡串行 | **保留我们的**：群里 N 题 = N 张卡 + N 次编辑 |
| 必须 2-4 个选项 | 支持省略 choices 的开放式提问 | 可后置：`options` 省略 → 纯文本提问卡 |
| `clarify.audit` 记录选项内容 | 观察者刻意不记答案 | 我们记的是选项文本（不含自填全文），可接受；自填内容建议不记 |

### 排序建议

1. **打字回复三分法**（真实困惑：用户打了字却没生效）——中等工作量，要改入站路由入口 + 提示文案。
2. **「等待已结束」的卡片状态**——小工作量，直接把 `abort` 的四个坑一起消掉。
3. **删掉 / 降级 `onTimeout: "abort"`**。
4. 后置：开放式提问、`1,3` 文本多选。
