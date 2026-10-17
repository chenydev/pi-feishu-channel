# 工具审批

agent 调用工具（执行命令、写文件等）之前，本扩展可以先征得管理员同意：在群里发一张审批卡，管理员点了才执行。
**审批默认关闭**，工具调用直接放行。本文说明几种审批模式、每种模式下谁来判定、怎么切换，以及怎么验证它真的在工作。
相关字段见 [configuration.md](configuration.md) 的 `approval` 一节。

| 模式 | 配置 | 谁判定 | 审批卡由谁发 |
|---|---|---|---|
| 关闭（默认） | 不配置，或 `approval.mode: "off"` | 不判定，直接放行 | 无 |
| 内置 | `approval.mode: "builtin"` | 本扩展（命令分级 + 免审工具） | 本扩展 |
| 插件 | `approval.mode: "pi-permission-system"`，并在 pi-permission-system 配置里写 `"authorizerChain": ["feishu-channel"]` | pi-permission-system | 本扩展（把它的「询问」变成审批卡） |

**关闭模式关不掉插件**：只要装了 pi-permission-system，它的拦截就先于本扩展执行，被它拒绝的调用照样被拒绝。
要完全不审批，还得卸掉插件或在它的配置里放行。

## 0. 切换模式

生效顺序：会话里的临时设置 > 环境变量 `FEISHU_CHANNEL_APPROVAL_MODE` > 配置文件 `approval.mode` > 默认 `off`。

| 命令 | 作用 | 谁能用 |
|---|---|---|
| `/feishu approvals` | 查看当前会话生效的模式、来源和规则摘要 | 任何人 |
| `/feishu approvals off\|builtin\|pi-permission-system` | 只改当前会话（也接受 `关闭` / `内置` / `插件`）；只在内存里，重启后失效 | 管理员 |
| `/feishu approvals <模式> -g` | 写进 `config.json` 的 `approval.mode`，所有会话立即生效，并清掉当前会话的临时设置（`--global` 同义） | 管理员 |
| `/feishu approvals reset` | 清掉当前会话的临时设置，回到全局 | 管理员 |

- 「当前会话」按会话键算：私聊是这个私聊，群里默认是发命令的人在这个群里的会话，话题是这个话题。`/new` 之后仍然有效。
- 设了环境变量时，`-g` 照样写文件，但环境变量优先，回复里会提示。
- 会话临时切到 `pi-permission-system` 也会弹卡；从 `pi-permission-system` 切走的会话，它的「询问」不再弹卡，由它自己拒绝。
- 日志：启动时 `feishu.approval.mode`（全局模式与来源），切换时 `feishu.approval.mode_changed`（`scope: session / global`）。

## 1. 审批卡

- **只有管理员能点**：`admins` 里的人，以及启动时自动识别的应用归属人和应用管理员（开发者、运营不算）。其他人点了会提示「仅管理员可审批」。
- **选项**：
  - 仅本次批准：只放行这一次调用；
  - 本会话批准：这个会话里同一个工具不再询问；
  - 始终批准：以后同一类调用都不再询问（见下文各方式下的含义）；
  - 拒绝。
- **有效期**：`approval.timeoutMs`（默认 5 分钟），超时视为拒绝；超时前 1 分钟会在群里 @ 管理员提醒一次。
  一轮任务结束时，这一轮里还没点的卡片全部失效。
- **合并**：同一轮里对同一个工具的并发请求合并到一张卡，点一次全部生效。
- **卡片内容**：工具名、参数（命令原文，凭据类字段打码）、为什么需要审批、触发这一轮的消息。

## 2. 内置审批

判定顺序：

1. **管理员免审**：`approval.adminSkipApproval: true` 时，管理员和应用归属人发起的调用直接放行（日志 `feishu.approval.admin_skip`）。默认关闭。
2. **bash 命令分级**（`approval.commandPolicy.enabled`，默认开启），按命令语义分三类：
   - 只读命令（`ls`、`cat`、`git status` 等）直接放行，日志 `feishu.approval.command_allow`；
   - 危险命令（`rm -rf /`、`curl … | sh`、`git push --force` 等）直接拒绝，不弹卡，日志 `feishu.approval.command_deny`；
   - 其余弹审批卡，卡片上写明分级理由，日志 `feishu.approval.command_ask`。

   命令本身只读、但某个参数能让它执行任意操作或写文件的（`find -exec`、`sort --compress-program`、
   `git grep --open-files-in-pager`、`rg --pre` 等），一律按「弹卡」处理 —— 短选项和长选项同等对待。

   判断不了的一律归为「弹卡」。可以用 `extraReadOnly` / `extraDangerous` 按命令名补充。
3. **免审工具**：`read`、`grep`、`find`、`ls`、`feishu_ask`（向会话提选择题，只发卡片，不授予任何权限）和 `approval.autoApprove` 里的工具直接放行；本会话已批准过的工具直接放行。
4. 其余弹审批卡。

在这种方式下，「始终批准」会把工具名写进配置文件的 `approval.autoApprove`，**对这个工具的所有调用永久生效**。
写入时以文件里当前的名单为底再加上这个工具，进程运行期间手工加进文件的项会保留，并且立即生效。
要撤销，从 `approval.autoApprove` 里删掉它再重启。

## 3. 插件：交给 pi-permission-system

[pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system)（下称 PS）是一个 pi 扩展，用规则文件决定每个工具调用是允许、拒绝还是询问。
设置 `approval.mode: "pi-permission-system"`（或环境变量 `FEISHU_CHANNEL_APPROVAL_MODE=pi-permission-system`）后：

- 本扩展不再按自己的规则判定。PS 的拦截先于本扩展执行，它拒绝的调用本扩展根本看不到；
- **它的「询问」变成飞书审批卡**（见下文 §4）；
- **插件没装上时自动退回内置审批**（日志 `feishu.approval.plugin_unavailable`），不会因此变成全部放行。

**版本要求：PS 27.0.0 及以上。** 更早的版本不按会话发布服务，本扩展挂不上去，它的「询问」一律被拒绝。
启动日志 `feishu.approval.ps_link` 写出检测到的版本；版本过低时另有 `feishu.approval.ps_version_unsupported`。

## 4. 把「询问」变成审批卡

PS 把「询问」交给它的**授权链**：按配置 `authorizerChain` 的顺序问每个环节，环节回答放行、拒绝或「交给下一个」；
都不回答时由 PS 自己处理 —— 飞书会话没有终端界面，结果是拒绝。本扩展在每个飞书会话里注册一个名为 `feishu-channel` 的环节，
**要在 PS 的配置里写上它才生效**（PS 的全局配置在 `<pi 的 agent 目录>/extensions/pi-permission-system/config.json`）：

```json
{
  "authorizerChain": ["feishu-channel"]
}
```

没写上时，启动日志有 `feishu.approval.ps_link_not_in_chain`，`/feishu doctor` 的 `ps_link` 项不通过。

环节收到「询问」后：

1. 会话不是本扩展管的，或这个会话的审批模式不是 `pi-permission-system`：交还 PS（结果是拒绝），日志 `feishu.approval.ps_link_mode_skip` / `ps_link_no_route`；
2. **访问路径类的请求不弹卡**：PS 规定授权链不能放行 `path` 和 `external_directory` 两类请求（读写工作目录以外的文件等），
   弹了卡也批不下来。这类请求直接交还 PS（结果是拒绝），日志 `feishu.approval.ps_link_capped`。
   **需要访问时，在 PS 的配置里放行对应路径**；
3. 发起人是管理员且开了 `approval.adminSkipApproval`：直接放行；
4. 命中「始终批准」或本会话批准过的规则：直接放行（日志 `feishu.approval.ps_always_approved` / `ps_session_approved`）；
5. 其余弹审批卡，管理员的选择原样交回 PS（日志 `feishu.approval.ps_link_decision`）。

**卡片显示完整命令**：PS 的规则可能只匹配命令的一部分（例如规则 `echo *` 匹配 `echo x > ~/.bashrc` 里的 `echo x`）。
卡片正文显示实际要执行的完整命令，理由里写命中的规则和规则匹配的部分。

**本会话批准、始终批准都按 PS 的规则名记**（如 `echo *`）：

- 本会话批准：只在这个会话里有效，`/new` 之后失效；
- 始终批准（`approval.plugin.alwaysApprove`，默认开启）：所有会话命中同一条规则都直接放行，保存在运行时目录的 `ps-always-approved.json`。
  查看用 `/feishu always`，撤销用 `/feishu always revoke <规则名>`（例如 `/feishu always revoke echo *`），只有管理员能用。
  关闭 `alwaysApprove` 后卡片上只有三个选项；
- 一条 bash 命令里有几段都需要询问时（如 `npm i && git push`），每段的规则都批准过才自动放行，卡片理由里列出全部规则；
- PS 没给出规则名的请求，「始终批准」退化为本会话批准（日志 `feishu.approval.ps_always_degraded`）。
- 规则名是**纯通配符**（PS 配置里的 `"*"`，即「任何值都询问」）时同样只能本会话批准：
  它匹配任何命令、任何工具，落盘后会把整个审批关掉。旧版本写进规则表的 `*` 不会再生效，下次落盘时清掉。

**限制**：飞书会话里由 subagent 发起的「询问」不会弹卡 —— PS 只把子会话的询问交给有终端界面的会话应答。

### 日志

一次成功的审批，日志按顺序是：

```
feishu.approval.ps_link                         启动时：PS 版本、authorizerChain、是否写上了本扩展
feishu.approval.audit  decision: ps_ask         弹卡（paramsSummary 是命令）
feishu.approval.audit  decision: once / session / always / deny   管理员的选择（含 operatorOpenId）
feishu.approval.ps_link_decision                交回 PS 的结果（verdict、choice、规则名）
```

```bash
grep -E 'feishu\.approval\.(ps_|audit)' <日志文件>
```

最终以命令真的执行了为准（agent 的回复里有命令输出）。

## 5. 验证

### 隔离端到端测试

`scripts/e2e/ps-authorizer.ts` 用真实的 pi 和真实的 PS，在临时目录里走一遍审批链路，只有「管理员点卡片」这一步是模拟的。
不需要飞书凭据，也不需要容器；需要本机装了 pi、装过 PS，并且 pi 能调用一个模型。

```bash
# PS 默认从 ~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system 找，也可以用 PS_PACKAGE 指定；
# 模型默认用 ~/.pi/agent/settings.json 的默认模型，也可以用 E2E_PROVIDER / E2E_MODEL 指定
npx tsx scripts/e2e/ps-authorizer.ts              # 期望：弹一次卡，管理员批准，命令执行
npx tsx scripts/e2e/ps-authorizer.ts deny         # 期望：弹一次卡，管理员拒绝，命令不执行
npx tsx scripts/e2e/ps-authorizer.ts nochain      # 对照组：authorizerChain 没写上，期望不弹卡，命令被拒绝
```

判据是命令的副作用（命令把一个随机串写进文件，脚本检查文件内容），而不是 pi 的输出 ——
`echo` 的输出可以被模型猜出来，命令没执行也可能答对。脚本通过时退出码为 0。

### 真实环境

步骤见 [operations.md](operations.md) 的「上线验收」。要点：

- pi-permission-system 的配置里**必须有「询问」规则**，并且 `authorizerChain` 里写上 `feishu-channel`。只有允许和拒绝规则时永远不会弹卡；
- 用会调用工具的消息触发，例如「用 bash 执行 `echo SMOKE-1`，把输出原样告诉我」；
- 审批卡必须由管理员本人点。群机器人 webhook 可以触发对话，但它不是管理员，点不了卡。
