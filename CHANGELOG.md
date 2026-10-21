# Changelog

发版打 `vX.Y.Z` tag；发版之间累积的改动写在「未发布」一节。安装时建议钉到 tag（见 README「用 pi 从 git 安装」）。

## 未发布

### 提问（`feishu_ask`）

- **有界等待**：发出卡片后等用户作答 **60 秒**（`clarify.waitMs`，工具可用 `waitSeconds` 按次覆盖，
  `0` = 回到纯异步）。等到了就把答案**当作工具结果**返回，模型在同一轮继续 —— 原来答案是作为
  「一条新消息」到达，模型往往重新规划，用户点了答案却得到一次新的思考。
- **超时默认不替用户决定**：只告诉模型「还没答，不要重复提问、不要假设答案」，任务停下等用户。
  超时后卡片**保持可点**；原子卡（点一下即答的那种）会重绘一行「⏳ 已经等了一会儿…这张卡仍然有效」，
  表单卡不重绘（用户可能正在勾选，整卡替换会清掉没提交的输入）。
- **打字回复分三种**（对照 hermes）：数字编号或选项原文（忽略卡片上的 ⭐/（推荐）装饰）**就是答案**
  —— 工具正在等时直接交回给它，超时后才答则把消息改写成标准答案并标「补充作答」；长得像选择但无效
  （`9`、越界列表）**保留提问**并回一句让他重试；其它散文（补充说明、追问、「等下我看看」）照常进会话，
  **提问保留**、卡片仍可点：工具正在等时立刻返回「用户先发了新消息，卡片仍然有效」（日志
  `feishu.clarify.wait_interrupted`），之后再作答按「补充作答」处理。只有回 `skip` 才作废提问，
  卡片重绘成「⏭ 已跳过」（只读、保留全部选项）。多选也接受 `1,3` / `1 3`。
- **`/stop` 能打断等待**（`ctx.signal`），记录保留 —— 中止不等于放弃作答机会。
- 超时**之后**才点卡作答（答案只能作为新消息到达）：消息带「（补充作答：之前等作答超时了，当时没有按任何选项继续）」，
  模型据此纠正方向，而不是把它当成新指令重做一遍。
- `/progress` 有待答提问时显示「有 N 个提问在等你作答」；会话回收的保护窗口是 **15 分钟**
  （不是卡片 24 小时 TTL，否则空闲会话永远回收不了）。
- 修复：工具正在等答案时点卡作答，答案已经作为工具结果交回，却还会再发一条「[选择] …」注入同一轮，
  模型收到两次同样的答案。现在和打字作答一样，有工具在等就不再进会话（日志 `feishu.clarify.answered`
  的 `result` 记为 `tool_result`）。
- 修复：等待中打字说别的事（散文，或多题卡用文字回答），工具一直等到超时，那条消息也跟着被挡到超时之后。
  现在工具立刻返回（不再误报成「超时未作答」），消息紧接着进会话。
- 修复：模型给的 `waitSeconds` 没有上限，填个 86400 就能让一轮挂一整天、会话队列跟着堵住。
  现在最多 10 分钟（`clarify.waitMs` 配得更大时以它为准），并且总比 `runToolIdleTimeoutMs`
  短 5 秒 —— 否则等待中整轮会被当成「工具没有输出」中止。截断时记 `feishu.clarify.wait_clamped`。
- 清理：`config.example.json` 删掉已移除的 `clarify.onTimeout`，配置说明里不再提它。

### 审批

- 修复：`!<命令>` 按 pi-permission-system 的 bash 规则把关时，只命中 **allow** 规则的命令被当成「需审批」
  拒绝执行（按段判定那次改动丢了动作判断）。现在逐段判定、取最严：每段 deny → ask → allow → `*` 默认。
  顺带让 allow 规则真正生效 —— 以前它们一直被忽略，`{"*": "deny", "ls": "allow"}` 下 `!ls` 也被拒。
- 修复：同一张审批卡几乎同时合并两个请求、其中前一次重绘失败时，token 被还原成旧值，
  而屏幕上是后一次画出的卡 —— 又成了点不动的卡。重绘期间这张卡已被批准 / 拒绝时，还会给已经
  决定了的请求再弹一张审批卡。现在同一张卡的合并串行进行，重绘期间卡已决定则新请求跟着同一个决定。

### 准入与运维

- 修复：开了 `rateLimit.perUserPerMinute` 后，被限流的人发 `/stop`、`/new` 也被静默丢弃，没法停下失控的任务。
  现在桥命令不计数也不拦；不是桥命令的 `/skill:xxx`、`!<命令>` 照常计数。
- 修复：长回答导出附件（`exports/reply-*.md`）的回收挂在会话归档上，而归档默认关闭
  （`retention.sessionDays: 0`），默认配置下附件照样只增不减。现在由产生它们的 `longReply.asFile`
  自己回收（启动时一次，之后每 6 小时，只留最近 200 份），并且 24 小时内的文件不删 ——
  它们可能还在发送队列里等重试。

### 会话

- 修复：两条文本相同的消息都并入了当前一轮、只执行了其中一条时，收尾会把两条都退回队列，
  执行过的那条又跑一遍。现在按出现次数核对 pi 队列里剩下的文本。
- 一轮收尾清空 pi 队列时，别的扩展排的 followUp（只在一轮异常结束时会残留）会被一并清掉。
  行为不变（不清的话它会混进下一条飞书消息那一轮执行），但现在记 `feishu.conv.followup_dropped`，不再无声消失。

### 文档

- `rateLimit`、`metrics`（`/healthz` + `/metrics`）、`/feishu dropstats`、`/feishu outbox list|retry` 补进 README
  （可选能力、命令列表）、运维 skill 和 `config.example.json`；docs/operations.md §1 补上探活端点。

- 维护（公开仓库）：测试里原来直接用了真人姓名当 `senderName`，换成占位符「示例用户」。
  同时加了一条护栏测试 `tests/public-placeholders.test.ts`：扫源码/文档/测试里的
  `ou_`/`oc_`/`cli_` 长十六进制串（真实 id 的形态），发现就失败 —— 它只拦形态、不维护白名单，
  所以代码里不需要写任何真实 id。
- 重构（会话）：`/undo`、`/retry`、`/fork`、`/export` 搬进 `session/history-ops.ts` —— 它们是
  「改历史」而不是「跑一轮」：不调模型、必须等空闲、每步都写历史或换指针。依赖（会话表、
  忙判定、打开 agent、重投消息）显式传入，模块可单独测。管理器 1650 → 1529 行。
- 重构（会话）：类型定义搬到 `session/session-types.ts`（`BridgeSession`、`QueuedMessage`、
  `ConversationManagerDeps` 等，全是无逻辑的接口），工具档位解析搬到 `session/tool-policy.ts`。
  管理器 re-export 原名字，历史导入路径不变。
- 重构（会话）：只读视图（队列统计/调度快照/`/queue list`/`/progress`/用量快照）搬到
  `session/session-views.ts` —— 全是读操作，和「下一轮怎么跑」没有共享状态。管理器 1342 → 1301 行。

## 0.3.2

### 提问卡片

- 改进：**作答后卡片留在原地变只读**，不再替换成一段摘要 —— 题目、全部选项（选中的打勾、
  没选的原样保留）、自填内容都还在，复选框 `disabled`、按钮撤掉。多题时**默认收起**，标题里直接带
  答案（`Q2 · 输出成什么格式？ —— ✅ Markdown 表格`），群里回看先看到结论、点开看全部选项。
- 改进：**长选项不再用「编号列表 + 选 1/选 2」两段式按钮** —— 选项文字超过 14 字时直接平铺
  复选框（复选框在前、完整选项在后），勾一个即作答。原来那版正文列一遍、按钮再对照一遍，
  回看和点击都要来回找。短选项（≤14 字）仍是整行按钮：点一下即答。
- 改进：题目之间加分割线（折叠面板收起时边界太淡）；表单底部一行说明（「每题至少勾一项或自填；
  标「单选」的只能勾一个」）；单选勾了多个时提示说清勾了哪几个
  （`只能选一个，现在勾了 2 个（A、B）—— 取消其中一个再提交`）。
- 新增：`radio` 参数 —— 强制单题单选用勾选式（即使选项很短）。

### 已验证的平台行为

- 复选框带 `behaviors: callback` 时，点击回调**带 `value`**（和表单提交「不回传按钮 value」不同），
  所以「勾一个即作答」成立；作答后整卡 PATCH 替换为只读版，实测未被拒绝。

## 0.3.1
### 新能力（默认关闭）

- `/healthz` + `/metrics`（`metrics.enabled`，默认关）：只读 HTTP 端点。`/healthz` 用状态码表达
  健康（200 = 连接正常且心跳未过期，503 = 断线/心跳停了），`/metrics` 输出 Prometheus 文本格式
  （连接状态、重连数、待投递/失败条数、待审批、消息计数、兜底 rejection 数）。默认只绑 `127.0.0.1`
  —— 端点没有鉴权，容器里要暴露给探针再配 `metrics.host: "0.0.0.0"`。
- 按人限流 `rateLimit.perUserPerMinute`（默认 0 = 不限）：放行的人在 60 秒滑动窗口里超过上限后，
  后面的消息直接丢并计入 `rate_limited`。**不回话** —— 对方正在刷屏，回一句只是放大流量。
  上限现读配置（live 字段），`/feishu config reload` 即生效。

### 新增命令

- `/feishu dropstats`：准入丢弃按原因计数（`bots_disabled` / `not_allowlisted` / `bot_not_mentioned` /
  `rate_limited` …），每个原因带一句「怎么放行」。只给管理员：原因分布能反推出谁被挡了。
  同一份数据也写进 `status.json` 的 `dropReasons`。
- `/feishu outbox list|retry <id 前缀|all>`：死信不再只活在日志里。列表带可读原因（无发言权限 /
  编辑次数用尽 / 附件丢失），重投按 id 前缀匹配，重投后是全新的尝试次数。
- `/feishu doctor` 默认结论版：只列异常项，全绿时一行「N 项检查全部正常」；`/feishu doctor full`
  才列全部。19 项逐条刷屏时，真正有问题的那条反而找不到。

### 内部

- 状态文件统一走 `atomicWriteFile` / `atomicWriteJson`（`src/runtime/atomic-file.ts`）：原来 11 个模块
  各写了一遍「临时文件 + rename」，差异只在缩进、权限、是否留换行，改一处特性要改 11 遍。现在
  统一 0600 权限、同目录临时文件名带 pid + 序号（避免撞名写串）、失败清临时文件、可选 `fsync`。
- `status.json` 补上运维看得懂的指标：出站投递耗时 **p50/p95**（最近 200 次成功投递，从真正开始发送算起，
  不含排队）、常驻内存的条目数 `caches`（引用原文缓存 / 实时写入链 / 待点提问卡 / 待处理记录 /
  去重表 / 未决审批）和 `unhandledRejections`。
- 进程级兜底（`runtime/process-guards.ts`）：未处理的 promise rejection 记日志并计数，不再让整个桥
  退出 —— 一条漏 `await` 的路径不该带走所有进行中的会话。计数进 `status.json`，`/feishu doctor`
  新增 `unhandled_rejection` 项（> 0 就报警），兜底不等于把 bug 藏起来。
- 待处理记录（`pending.jsonl`）改成**追加式日志**：原来每次变动都要把全部记录重写一遍，一条消息的
  成本是 O(待处理条数)。现在只追加一行（删除写墓碑），行数超过记录数三倍且多于 50 行时压实。
  旧文件格式天然兼容（同样是「快照 + 后写覆盖先写」）。
- 会话模块拆分（纯搬运，行为不变）：拼一轮输入 → `session/turn-input.ts`；会话表与
  `sessionId → 会话` 的自我修正索引 → `session/session-table.ts`；用户可见提示的投递规则 →
  `session/notices.ts`。三个模块各自可单独读、单独测。
## 0.3.0

- 修复（开通申请）：部署里没有可审批的人（没配 `admins`、也查不到应用归属人）时，
  「暂时找不到可以审批的人」这条提示不记状态、不计配额 —— 每个被挡的人每发一条消息都会再收到一次，
  几个人就能把群刷满。现在按冷却期（默认 1 小时）静默并计入每小时配额。
- 新增（提问）：`feishu_ask` 支持**一次问多题**（1-4 题）、**多选**与**自填**。旧用法（单题 + 2-4 个选项）
  完全不变：还是「点一下即答」的整行按钮卡。只有在多题、多选或允许自填时才变成表单卡：每题收进一个
  折叠面板，选项是平铺复选框，**每题下面还有一个自填框**（想说的不在选项里时直接填），底部
  「提交 / 重置」，提交一次把整卡作答回传（`[选择] 共 N 题 …`）。选项可以标「推荐」（`recommended`
  下标 + `reason` 一句理由）：推荐项打 ⭐ 并标「推荐」，理由显示在题目下面。
- 新增（提问）：**单题单选也能进表单**（`allowOther: true`）：多一个自填框、能先勾再提交（可反悔）。
  不给这个参数时单题单选仍是「点一下即答」，不牺牲最快路径。
- 新增（提问）：**所有形态都支持推荐答案** —— 按钮卡（⭐ 写进按钮文案）、表单卡（⭐ 复选框 + 题下理由）、
  连卡片发不出去时的文字回退也带 `⭐ 选项（推荐）` + `💡 理由`。推荐用 `recommended`（下标）+ `reason`（一句理由）。
- 修复（提问）：飞书的**表单提交不回传按钮的 `value`**（实测只有卡片消息 id 和 `form_value`），
  提交按钮因此被当成「未知按钮」静默丢弃 —— 用户看到的就是「点了没反应」。现在卡片回调在没有
  `op` 时按「这张卡是不是某个还没答的提问」认领到表单提交；同时把平台回传的字段名记进日志
  （`feishu.transport.card_action` 的 `hasFormValue`/`formFields`），下次再变能直接看出来。
  单选在卡片层拦不住（复选框互不联动），由服务端校验并提示「只能选一个」，卡片不失效、改完可再提交。
  折叠面板需要飞书客户端 ≥ 7.9；低版本会显示「升级客户端」占位，此时把 `clarify.panels` 设为 `false`
  （平铺布局，复选框不变）。
- 修复（会话）：消息用 steer 并入当前一轮时，只要注入调用返回成功就被当成「已处理」确认掉 ——
  但 Pi 可能在这轮消费它之前就收尾了（注入点正好在最后一个 turn 边界），那条消息**再也不会被执行**，
  用户等不到任何回复。现在收尾时检查 Pi 侧队列（`clearQueue`；老 SDK 没有这个能力时退化为看
  turn 边界，且只有本轮确实有过 turn 结束事件才判定），还在队列里的退回桥的队列，作为独立一轮重跑。
- 修复（审批）：同一轮里第二个同类请求并入主卡时会给主卡换 token 并重绘；重绘失败（网络抖动、
  卡片编辑配额用尽）时 token 已经换了、卡面还是旧的 —— 管理员点它只会得到「审批上下文不匹配」，
  也就是一张点不动的卡，只能等超时。现在重绘失败会撤销合并、两个请求各弹一张卡。
- 修复（出站）：长回答拆成多条时，其中一段永久失败仍会把其余段发出去，而提示只说「回复发送失败」
  —— 读者会以为整条回复都没到，实际是残缺的正文。现在失败回调带上同一组里的条目数，
  提示改为「回复的一部分没有发送成功……内容可能不完整」。
- 修复（会话）：`/stop` 的停止标记只在**那一轮**的收尾里复位 —— 上一轮收尾期间（记用量、撤销审批卡）
  到达的 `/stop` 会把标记留给下一条排队任务，它被当成「用户主动停止」：不打完成表情、
  出错时也不按失败提示。现在每一轮开始先清掉这个标记（与 `/stop` 回执「排队任务照常执行」一致）。
- 修复（会话）：出错 / 中断类的提示走 `notify` 发送，失败时被静默吞掉（连日志都没有）——
  用户看到「什么都没说」，排障的人查不到线索。现在失败记 `feishu.conv.notify_failed`（带错误原因），
  入队被去重挡掉时记 `feishu.conv.notify_not_queued`。
- **行为变更（准入）**：`allowlist` 策略下**空名单现在等于拒绝所有人**（与 `allowChats` / `allowUsers` 一致）。
  此前空名单被当成「不限制」—— 管理员发 `/feishu policy allowlist` 得到的回执是「已设置」，
  但实际谁都能触发。配置里已有 `groupRules.<id>.allowlist` 的部署不受影响；只设了全局
  `groupPolicy: "allowlist"` 却没有任何名单的部署，升级后会拒绝所有人的群消息（管理员仍豁免，
  可用 `/feishu policy <策略>` 改回，或补上名单）。`/feishu policy allowlist|blacklist` 的回执现在会说明实际效果。
- 修复（运维）：会话归档只在**启动**时跑一次 —— 长驻实例（几周不重启）永远归档不了新变旧的文件；
  长回答导出的 `exports/reply-*.md` 也从不回收，每次长回答留一个文件。现在每 6 小时巡一次，
  并只保留最近 200 份导出附件（日志 `feishu.retention` 带 `prunedExports`）。
- 修复（诊断）：`/feishu doctor` 原来对任何被准入的人输出全部细节 —— 宿主绝对路径、配置文件里的字段名、
  「始终批准」的放行规则名。现在只有管理员看得到 detail，其他人只看「✅/❌ + 异常条数」。
- 修复（审批）：桥自己用 PS 规则把关时把整串命令当一个命令去匹配，`cd /tmp && cat x.env` 因此错过
  `cat *.env: deny`，落到 `*: allow` 上直接放行。现在按 `&&` `||` `;` `|` 换行逐段判定（与 PS 的
  bash 规则语义一致），任一段 deny 就 deny。
- 修复（审批）：应用协作者只读第一页（50 人）—— 协作者超过 50 人时，后面的**应用管理员**不算隐式管理员，
  他们在群里点审批卡会被拒（「仅管理员」），而 `admins` 往往没写。现在会翻页（最多 20 页，超出时告警）。
- 修复（入站）：断线补收（重连后补上断线期间的消息）此前会**丢掉最新那几条**，且截断计数恒为 0：
  补收按「多要一条」探测截断，但接口单页上限 50 会被夹住，请求 51 条永远只回 50 条；再叠加升序取数，
  被丢掉的是最后几条 —— 正是用户等着的。现在按倒序取最近 N 条（超出时丢更早的）、翻回升序处理，
  并用接口的 `has_more` 统计截断。
- 修复（入站）：`/bot/v3/info` 取不到 `open_id` 时只在 info 级打一条空身份，症状是「群里 @ 机器人
  完全没反应」—— 每个 @ 都被判成「没 @ 我」丢掉，而日志里只有 `reason: bot_not_mentioned`。
  现在显式告警 `feishu.transport.bot_identity_missing`，写明后果与修法（配 `botOpenId` / 恢复读应用信息权限）。
- 修复（会话）：一条消息如果每次跑到一半就把进程带走，启动恢复会无限重放它（重启循环）。
  现在同一条消息第 3 次被恢复接管后不再自动重跑，改为给会话发一条说明（日志
  `feishu.conv.recover_pending_exhausted`）并终结这条记录。
- 修复（交互）：过期（`clarify.ttlMs`，默认 24 小时）但没人点的提问卡片会一直留在内存里 ——
  只有被点击时才顺手删除。现在新建提问时一并清理过期记录（带 `expired` 审计）。
- 修复（出站）：流式/进度的串行写入器按 messageId 留一条写入链，收尾时只 drain 不释放 ——
  每轮回复都留下一条（含正文闭包），长驻进程内存随轮次线性上涨。现在 final 接手与进度收尾后释放。
- 修复（入站）：被回复消息原文的缓存没有任何上限、过期项也不删 —— 每条「回复某条消息」都会往里塞一条
  原文（长文可达几十 KB），长驻进程内存随使用时长线性上涨。现在过期项命中时清掉，容量按
  `lastSentCacheSize`（默认 64）封顶、淘汰最旧。
- 修复（回复）：超长回答分片时，围栏写成 ` ``` ts `（围栏后带空格）、` ```c++ `、` ```js title=x ` 这类
  时识别不出代码块 —— 开围栏被当成正文、闭围栏被当成开围栏，正文被包进代码块。现在按完整 info string 识别。
- 修复（回复）：回答以引用块开头时（`> 结论：……`，很常见的"先给结论"格式），整块会被当成模型复述的
  注入提示删掉 —— 用户看不到第一段（常常就是结论）。现在只剥「复述桥注入内容」的引用块（含
  「正在回复的消息原文」等特征词），模型自己写的引用原样保留。
- 修复（卡片）：流式卡片收尾（写最终正文 + 页脚）期间到达的增量更新，会排在最终写入之后执行，
  把卡片正文改回中间态 —— 而 `finish` 仍返回成功，调用方不会再发一条文字兜底，
  用户看到的是「正文停在半截 + 页脚却显示完成」。现在收尾一开始就不再接受增量。
- 修复（会话）：一轮任务的收尾清理抛错（例如待处理记录落盘失败）时，pump 直接跳出 ——
  该会话队列里剩下的任务再也没有调度器启动，同时留下一个未处理的 rejection（Node 默认策略下进程退出）。
  现在记一条 `feishu.conv.pump_failed` 后继续执行队列。
- 修复（出站）：发送队列落盘失败（磁盘满、目录只读、超出文件容量上限）时，定时器回调里的异常没人接管 ——
  Node 默认策略会直接退出进程，已经送达的条目状态也可能还没落盘。现在记一条 `feishu.outbox.drain_failed`
  继续跑，队列与重试定时器照旧恢复。
- 修复（入站）：撤回合批窗口里**最后一条**消息后，合并出的那一轮仍以已撤回的消息为载体 ——
  回复会挂到撤回的消息上（飞书拒绝后走降级），待处理记录的合并也因为主记录已终结而丢掉其余成员记录
  （重启后重复重放）。现在载体回退到窗口里剩下的最后一条。（合批修好后才会遇到的路径。）
- 修复（运行时）：桥已启动后再次触发 `session_start`（TUI 里切换/恢复会话）会把运行中的配置对象换成新读的一份，
  后果有两个：① 各组件持有的还是旧对象，`/feishu config reload`、`/feishu policy`、`/feishu budget`、
  `/feishu footer`、`/feishu prompt` 回执说「已生效」但实际仍按旧值跑；
  ② 启动时查询到的应用归属人与应用管理员（隐式管理员）不会从文件读回来，换掉就丢 —— 之后所有管理命令、
  审批卡都回「仅管理员」。现在桥已在运行时不重建配置对象；改配置走 `/feishu config reload`。
- 修复（命令）：`/model <片段> -g` 在模糊匹配成功时，会把回执里的提示文案一起写进 pi 的 `settings.json`
  （`defaultModel` 变成 `gemini-2.5-flash（按「flash」匹配）`）—— 之后所有新会话都用一个不存在的模型启动，
  只能手改文件恢复。现在只取 `已切换模型：provider/id` 这一段；回执文案不变。
- 修复（出站）：一个会话的回复在退避重试（例如被限频，`Retry-After` 60 秒）时，**其他会话**新入队的回复
  也被这个定时器拖住，最多 60 秒才投递 —— 用户看到任务已完成，群里却迟迟没有答案。
  现在新条目入队时如果已有更晚的定时器会重排到立即执行；退避中的那条照旧等它自己的时间。
- 修复（入站）：平台重投一条**已经处理完**的消息时，桥会把它当成「准入前崩溃」的孤儿消息重新准入 ——
  同一个问题再跑一轮、群里多一条回复，可能重复执行带副作用的工具（日志里表现为 `recover_orphan` 而不是 `drop_duplicate`）。
  现在待处理记录终结（ack）时同时记一笔「已处理完」，重投按重复丢弃；真正的崩溃窗口（去重标记已写、待处理记录没登记）仍照旧恢复。
  批合并的消息逐个成员都记，成员被重投也不会重跑。
- 修复（入站）：群里的**合批实际从未生效** —— 每条新消息都会把上一条的合并窗口冲刷成单独一轮，
  `batch.textWindowMs` / `maxMessages` / `maxChars` / `batch.media` 形同虚设（连发、转发拆条各触发一轮任务、各一条回复）。
  原因是命令处理钩子在生产环境总存在，而它无条件冲刷窗口；现在只在真的来了命令（`/new`、`/stop` 等）时才先冲刷，
  普通消息不再打断合并。命令仍然先于窗口执行。
- **行为变更（审批）**：PS 规则名是纯通配符（配置里的 `"*"`）时，「始终批准」不再落盘，只在本会话有效（日志 `feishu.approval.ps_always_degraded`）。
  之前这种规则名会写进 `ps-always-approved.json`，而它匹配任何值 —— 管理员点一次就把所有工具、所有会话的审批永久关掉了，
  卡片上却只写着「命中规则：*」。旧版本已经写进去的 `*` 不再生效，并在下次落盘时清掉。
- 修复（审批）：只读命令白名单的「越权参数」只列了短选项，`git grep --open-files-in-pager=…`、`sort --compress-program=…`
  能在**不弹审批卡**的情况下执行任意命令（`git grep -O`、`sort -o` 一直是拦住的）。现在长选项同样收回白名单，
  `git diff|show|log` 的 `--ext-diff` / `--textconv`、`rg --hostname-bin`、`find -fprint0` 一并覆盖。
- **行为变更（表情）**：处理完成的消息加「DONE」表情（新字段 `reaction.doneEmoji`，默认 `"DONE"`），之前处理完只撤掉处理中表情，和「机器人没理这条」看不出区别。
  并入当前任务的消息（+1）、合批的几条消息也都会加；`/stop` 中止的不加。不想要设为 `""`。
  合批的几条消息处理失败时也都加失败表情，之前只加在其中一条上。
- 修复：并入当前任务的消息上的「+1」在这一轮结束后一直不撤，看起来像还在处理。现在结束时撤掉，换成完成或失败表情；
  当前任务失败、并入的消息退回队列重跑时，+1 换回处理中表情。
- 群的会话模式可以按群设置：`groupRules.<id>.sessionsPerUser` 为 `true` 时这个群每人一个会话，`false` 时全群共用，不设时跟随全局 `groupSessionsPerUser`。
  适合大多数群围绕一件事协作、少数群里几个人各做各的事。改完 `/feishu config reload` 即生效；发言人上下文（`agentContext.sender: shared`）和 `/sessions` 都按这个群的模式判断。
  reload 改了会话模式时，立即释放这些群里空闲的驻留会话：个人会话 `/resume` 进群后两边是同一个会话文件，旧句柄留在内存里时工具进度和审批会落到旧会话上。
- 新命令 `/feishu config reload`（管理员）：改完 `config.json` 后不用重启，重新读取文件，能热加载的字段立即生效。
  准入（`allowChats`、`allowUsers`、群策略、`groupRules` 等）、`groupSessionsPerUser`、`streamingCard`、`progress`、页脚、审批（`approval.plugin` 除外）、
  工作区、`usage` 等每次用到才读的字段都能热加载；应用凭据、超时、缓存容量、定时器间隔、可选能力的开关要重启，reload 不应用它们，只在回执里列出来。
  文件有错误时不应用任何改动。每个字段归哪类见 `docs/configuration.md` 新增的「改后」列，日志 `feishu.config.reloaded` / `reload_failed`。
- **行为变更（会话）**：`groupSessionsPerUser` 默认改为 `false`，群里所有人默认共用一个会话（键为 `<chatId>`），话题仍按话题共用。
  原先默认每人一个会话。要保持旧行为，在 `config.json` 里显式写 `"groupSessionsPerUser": true`；
  升级后没写这个字段的群会从一个新的共享会话开始，原来各人的会话文件仍在：群里发 `/sessions` 会列出本群切换前各人的个人会话（标明是谁的），
  本人或管理员 `/resume #N` 接着做，工作区一起带过来；恢复后这段上下文全群共用。
- **行为变更（用量）**：`usage.provider` 默认改为 `none`，不再默认查 DeepSeek 余额，页脚只显示美元、不折算人民币。
  用 DeepSeek 的要显式写 `"usage": { "provider": "deepseek" }`。
- **行为变更（进度）**：`progress.mode` 默认改为 `new`，只在换了工具时加一行，连续调用同一个工具不再逐条刷屏；要旧行为写 `"progress": { "mode": "all" }`。
- 修正 `streamingCard.enabled` 的说明：最终回答写进卡片，卡片写不进去时才改发普通消息。
- 修复：流式卡片开启约 10 分钟后，飞书会关闭它的流式模式（`200850 card streaming timeout`，之后 `300309 streaming mode is closed`），
  原先之后的写入全部失败，卡片一直停在「正在处理…」或半截内容：超过 10 分钟的长任务答案改发成另一条文字，空闲超时的中止说明也写不进卡片。
  现在撞到时改用整组件替换继续写（没有打字机效果），长任务的最终答案和页脚照常写进卡片，记一次 `feishu.stream_card.streaming_closed`。
- 卡片模式下任务失败或空闲超时，说明直接写进卡片，不再另发一条文字；卡片写不进去时才发文字。
- 等模型时说明发生了什么，不再只显示「正在处理…」（卡片正文末尾和进度消息的状态行，收到模型输出后消失）：
  - pi 遇到 503、限流等临时错误自动重试时，显示「模型服务暂时不可用（503），正在自动重试（第 1/3 次）」，日志 `feishu.conv.model_retry`；
  - 等模型时 1 分钟没有任何输出，显示「已 N 分钟没有收到模型输出，模型服务可能在排队，… 仍没有输出会自动中止」，日志 `feishu.conv.model_quiet`。
    DeepSeek 繁忙时不报错，只发 `: keep-alive` 让请求排队（最长 10 分钟），之前用户看不出任务卡在哪。
  - `/progress` 也会显示「pi 正在自动重试」。
- 空闲超时分两段：工具执行中（如 bash 跑构建、测试）按新配置 `runToolIdleTimeoutMs`（默认 60 分钟），等模型时仍按 `runIdleTimeoutMs`（10 分钟）。
  原先整轮统一 10 分钟，长时间没有输出的命令会被误杀。中止提示写明是哪个工具没有输出，还是一直没收到模型的输出；
  日志 `feishu.conv.run_idle_timeout` 新增 `phase`（`tool` / `model`）、`tool`、`toolMs`、`runMs`、`toolCalls`。
- 新命令 `/progress`：任务执行中随时查看做到哪了（运行多久、当前工具及其最近几行输出、待并入和排队数），立即回复，不经过模型、不打断任务。
- 工具执行超过 1 分钟时收到普通消息，先回一句「正在执行 …，你的消息会在这一步结束后交给模型」并提示 `/progress`
  （同一会话 5 分钟内一次，`queueNotice: false` 时不提示）；「已排队」提示里也加上了 `/progress`。
- **行为变更（澄清提问）**：`feishu_ask` 不再阻塞会话。卡片发出后本轮就结束，点选项等于以点击人身份发一条「[选择] 选项」消息，
  不点也可以直接打字回复；不再有 2 分钟超时，也不会在超时后由模型替用户选默认值。
  - 作答权限改为「能在这里 @ 机器人的人」（按准入判定），不再只限管理员；发起提问的普通成员现在能点自己的提问。
  - 卡片在答过一次、同一会话发出新提问、`/new` 或切换工作区时失效，兜底有效期新增配置 `clarify.ttlMs`（默认 24 小时）。
  - 提问记录落盘到 `clarifications.json`，重启后卡片仍能点；有提问的会话不再阻止句柄回收。
  - 日志：新增 `feishu.clarify.asked`、`answered`、`route_failed`；删除 `feishu.clarify.shutdown`。
- 开通申请（`onboarding.accessRequest`，默认关）扩展到个人：除了未放行的群里 @，群名单外的人 @、不在 `allowUsers` 里的人私聊，也会给审批人发申请卡。
  审批人可选「放行此群」「加入本群名单」「全局放行此人」「放行私聊」或「暂不放行」，结果写回 `config.json`。
  新增配置 `allowUsersAllGroups`（环境变量 `FEISHU_ALLOW_USERS_ALL_GROUPS`）：「全局放行此人」写到这里，这些人在所有群都能用（包括没放行的群），
  不放开私聊，群策略 `disabled` / `admin_only` / `blacklist` 照旧。
  频率：同一项申请 1 小时内只发一次，「暂不放行」后 24 小时不再发，新增 `onboarding.accessRequestMaxPerHour`（默认 10）限制每小时总数，
  超出记 `feishu.access_request.silent`（`reason: rate_limited`）；放行个人记 `feishu.access_request.user_allowed`。
- **破坏性变更（准入）**：`groupAlsoOnReply` 默认改为关闭。`mention` 策略下回复机器人发出的消息，现在也要 @ 机器人才会触发；
  要保留原来的行为，在 `config.json` 里写 `"groupAlsoOnReply": true` 或设环境变量 `FEISHU_GROUP_ALSO_ON_REPLY=1`。
  这个开关对整个实例生效，不分群和人；只认进程内存里最近 `lastSentCacheSize` 条机器人消息，重启后清空。`config.example.json` 同步改为 `false`。
- **破坏性变更（启动）**：新增环境变量 `FEISHU_CHANNEL_ENABLED`，**默认关闭**。只有设了 `FEISHU_CHANNEL_ENABLED=1`（`true` / `yes` / `on` 也行）
  并且是 `pi --mode rpc` 启动的进程才自动连飞书；本机其他 pi 进程（包括编辑器插件拉起的 RPC 进程）都不连。
  **升级前给部署的进程加上这个环境变量**，否则升级后不再连接。没设时日志 `feishu.bridge.autostart_skipped` 的 `reason` 为 `disabled`
  （不是 RPC 模式时为 `mode`）；`/feishu:start` 手动启动不受开关限制。不放进 `config.json`：配置文件是本机所有 pi 进程共用的。
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
- `/help <命令>` 看单个命令的详细用法（命令名可以不带 `/`、用别名或两段式，如 `/help workspace`、`/help feishu approvals`）。
  先给 `/workspace` 写了逐条说明：查看、切换、`add` / `rm` / `default` 各自的权限和注意事项；帮助卡底部提示这个用法。
- 新增 `/reload`：当前会话重新加载扩展、技能、提示模板和上下文文件，对话历史不变；
  装完新技能后不用再 `/new`。有任务在跑或排队时拒绝；回执列出数量、新增 / 移除的技能和加载失败的条目，
  重载后重新套用按群工具档位（日志 `feishu.conv.reloaded`、`feishu.conv.reload_failed`）。
- 澄清选择卡（`feishu_ask`）：选项超过 14 个字时不再截断成按钮文字，改为正文列出带编号的完整选项、按钮只放「选 1」「选 2」…并排一行；
  选项都短时仍是每项一个整行按钮。工具参数说明提示模型把选项写短、细节放进问题。
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
