# 工具审批

agent 调用工具（执行命令、写文件等）之前，本扩展可以先征得管理员同意：在群里发一张审批卡，管理员点了才执行。
本文说明三种工作方式、每种方式下谁来判定，以及怎么验证它真的在工作。

| 方式 | 配置 | 谁判定 | 审批卡由谁发 |
|---|---|---|---|
| 内置策略（默认） | `approval.policyEngine: "bridge"` | 本扩展（命令分级 + 免审工具） | 本扩展 |
| 交给 pi-permission-system | `approval.policyEngine: "pi-permission-system"` | pi-permission-system | 无（它的「询问」没人应答 → 拒绝） |
| 交给 pi-permission-system + 父会话转发 | 上一行 + `approval.forwarding.enabled: true` | pi-permission-system | 本扩展（把它的「询问」变成审批卡） |

## 1. 审批卡

- **只有管理员能点**：`admins` 里的人，以及启动时自动识别的应用归属人和协作者。其他人点了会提示「仅管理员可审批」。
- **选项**：
  - 仅本次批准：只放行这一次调用；
  - 本会话批准：这个会话里同一个工具不再询问；
  - 始终批准：以后同一类调用都不再询问（见下文各方式下的含义）；
  - 拒绝。
- **有效期**：`approval.timeoutMs`（默认 5 分钟），超时视为拒绝；超时前 1 分钟会在群里 @ 管理员提醒一次。
  一轮任务结束时，这一轮里还没点的卡片全部失效。
- **合并**：同一轮里对同一个工具的并发请求合并到一张卡，点一次全部生效。
- **卡片内容**：工具名、参数（命令原文，凭据类字段打码）、为什么需要审批、触发这一轮的消息。

## 2. 内置策略（默认）

判定顺序：

1. **管理员免审**：`approval.adminSkipApproval: true` 时，管理员和应用归属人发起的调用直接放行（日志 `feishu.approval.admin_skip`）。默认关闭。
2. **bash 命令分级**（`approval.commandPolicy.enabled`，默认开启），按命令语义分三类：
   - 只读命令（`ls`、`cat`、`git status` 等）直接放行，日志 `feishu.approval.command_allow`；
   - 危险命令（`rm -rf /`、`curl … | sh`、`git push --force` 等）直接拒绝，不弹卡，日志 `feishu.approval.command_deny`；
   - 其余弹审批卡，卡片上写明分级理由，日志 `feishu.approval.command_ask`。

   判断不了的一律归为「弹卡」。可以用 `extraReadOnly` / `extraDangerous` 按命令名补充。
3. **免审工具**：`read`、`grep`、`find`、`ls` 和 `approval.autoApprove` 里的工具直接放行；本会话已批准过的工具直接放行。
4. 其余弹审批卡。

在这种方式下，「始终批准」会把工具名写进配置文件的 `approval.autoApprove`，**对这个工具的所有调用永久生效**。
要撤销，从 `approval.autoApprove` 里删掉它再重启。

## 3. 交给 pi-permission-system

[pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system) 是一个 pi 扩展，用规则文件决定每个工具调用是允许、拒绝还是询问。
设置 `approval.policyEngine: "pi-permission-system"`（或环境变量 `FEISHU_CHANNEL_POLICY_ENGINE=pi-permission-system`）后：

- 本扩展不再做判定，也不弹卡。pi-permission-system 的拦截先于本扩展执行，它拒绝的调用本扩展根本看不到；
- **它的「询问」规则需要一个能应答的界面**。飞书会话里没有，所以不开转发时，命中「询问」的调用一律被拒绝；
- **扩展没装上时自动退回内置策略**（日志 `feishu.approval.policy_engine_unavailable`），不会因此变成全部放行。

## 4. 父会话转发

pi-permission-system 支持把「询问」转发给一个「父会话」来应答：子会话把请求写成文件，父会话写回响应。
打开 `approval.forwarding.enabled`（或 `FEISHU_PS_FORWARDING=1`）后，本扩展充当这个父会话：

1. 在进程环境里声明父会话（`PI_SUBAGENT_PARENT_SESSION` 和 `PI_AGENT_ROUTER_PARENT_SESSION_ID`，值是 `approval.forwarding.parentSessionId`，默认 `feishu-channel-parent`），
   于是这个进程里所有会话的「询问」都转发过来；
2. 在 `<pi 的 agent 目录>/sessions/permission-forwarding/` 下写心跳文件，表明「有人在应答」；
3. 读到请求文件后弹审批卡，管理员点完写回响应，pi-permission-system 随即放行或拒绝。

**两个开关要一起开**：转发只在 `policyEngine` 为 `pi-permission-system` 时生效，否则同一次调用会被判定两次，日志 `feishu.approval.ps_forwarding_inactive` 会提示。

**卡片显示完整命令**：pi-permission-system 的规则可能只匹配命令的一部分（例如规则 `echo *` 匹配 `echo x > ~/.bashrc` 里的 `echo x`）。
卡片正文显示实际要执行的完整命令，理由里注明规则匹配的部分。

**始终批准**（`approval.forwarding.alwaysApprove`，默认开启）：按 pi-permission-system 给出的规则名（如 `echo *`）记录，
以后命中同一条规则的请求直接放行，不再弹卡。规则保存在运行时目录的 `ps-always-approved.json`。

- 查看：`/feishu always`
- 撤销：`/feishu always revoke <规则名>`，例如 `/feishu always revoke echo *`

这两个命令只有管理员能用。关闭 `alwaysApprove` 后卡片上只有三个选项。

**关闭转发**时，本扩展会撤回自己设置的环境变量。之后 pi-permission-system 会回到自己的处理方式（没人应答就拒绝），
不会把请求转发到一个没人读的目录。

### 转发链路的日志

一次成功的转发审批，日志按顺序是：

```
feishu.approval.ps_forwarding_started          转发应答方已启动（启动时一次）
feishu.approval.ps_forwarding.audit  event: ps_forwarding.request_seen    读到请求
feishu.approval.audit  decision: ps_forwarding_ask  paramsSummary: <命令>  弹卡
feishu.approval.audit  decision: once / session / always / deny           管理员的选择（含 operatorOpenId）
feishu.approval.ps_forwarding.audit  event: ps_forwarding.answered        响应已写回
```

```bash
grep -E 'ps_forwarding|decision:' <日志文件>
```

最终以命令真的执行了为准（agent 的回复里有命令输出）。

## 5. 验证

### 隔离端到端测试

`scripts/e2e/ps-forwarding.ts` 用真实的 pi 和真实的 pi-permission-system，在临时目录里走一遍转发链路，只有「管理员点卡片」这一步是模拟的。
不需要飞书凭据，也不需要容器；需要本机装了 pi、装过 pi-permission-system，并且 pi 能调用一个模型。

```bash
# pi-permission-system 默认从 ~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system 找，也可以用 PS_PACKAGE 指定；
# 模型用 E2E_PROVIDER / E2E_MODEL 指定（例如 E2E_PROVIDER=anthropic E2E_MODEL=claude-haiku-4-5）
npx tsx scripts/e2e/ps-forwarding.ts              # 期望：弹一次卡，命令执行
npx tsx scripts/e2e/ps-forwarding.ts none         # 对照组：不声明父会话，期望命令被拒绝
npx tsx scripts/e2e/ps-forwarding.ts --delay 6    # 管理员 6 秒后才点，验证心跳让子会话一直等着
```

判据是命令的副作用（命令把一个随机串写进文件，脚本检查文件内容），而不是 pi 的输出 ——
`echo` 的输出可以被模型猜出来，命令没执行也可能答对。脚本通过时退出码为 0。

### 真实环境

步骤见 [operations.md](operations.md) 的「上线验收」。要点：

- pi-permission-system 的配置里**必须有「询问」规则**。只有允许和拒绝规则时永远不会弹卡；
- 用会调用工具的消息触发，例如「用 bash 执行 `echo SMOKE-1`，把输出原样告诉我」；
- 审批卡必须由管理员本人点。群机器人 webhook 可以触发对话，但它不是管理员，点不了卡。
