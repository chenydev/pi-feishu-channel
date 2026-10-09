# pi-feishu-channel 开发约定

pi 的飞书 / Lark 通道扩展：把 pi 编码助手接进飞书群聊与私聊。本仓库公开，入口 `src/index.ts`（`package.json` 的 `pi.extensions`），随包附带运维 skill `skills/feishu-channel-ops/`（`pi.skills`）。

## 先读

| 要做什么 | 看哪里 |
|---|---|
| 了解模块分层、一条消息的路径、不变量 | [docs/architecture.md](docs/architecture.md) |
| 提交信息、注释写法、用词 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 测试分层、飞书假服务、写测试的约定 | [docs/testing.md](docs/testing.md) |
| 配置字段 | [docs/configuration.md](docs/configuration.md)（由 `src/config/schema.ts` 生成） |
| 审批链路 | [docs/approval.md](docs/approval.md) |
| 运维、排障、上线验收 | [docs/operations.md](docs/operations.md) |

## 命令

```bash
npm run check        # tsc 未使用检查 + biome lint + 全量测试；每个提交都要能单独通过
npm run docs:config  # 改了 src/config/schema.ts 后重新生成 docs/configuration.md
npm run docs:check   # 检查文档里的相对链接
```

## 约定

- **新增的可选能力默认关闭**，用 `config.json` 字段或环境变量显式开启；在 `tests/features/` 里覆盖「开 / 关」两种配置。
- **配置字段只在 `src/config/schema.ts` 定义**，`docs/configuration.md` 不手改，改完 schema 跑 `npm run docs:config`。
- **行为变化写进 `CHANGELOG.md` 的「未发布」一节**，和代码放在同一个提交里。
- **公开仓库**：不得出现密钥、内网地址、真实的 open_id / 群 id / app_id / webhook。示例一律用占位符（`ou_…`、`oc_…`、`cli_…`）。
- 本地测试通过不等于可用：改动涉及准入、路由、卡片、审批时，按 [docs/operations.md](docs/operations.md) §5 在真实环境验收。
- 不要在运行中的实例旁再起一个 pi 进程测试（会抢同一应用的连接）；需要时用独立的 `PI_CODING_AGENT_DIR` 和 `FEISHU_CHANNEL_HOME`。

## 改动后同步检查

**每次新增功能或修复问题，都要检查下面这些是否需要一起更新**，需要的话放在同一个提交里。
`CHANGELOG.md` 每次都要看；运维 skill `skills/feishu-channel-ops/SKILL.md`（下表简称 **skill**）最容易漏，单独标出。

| 改动涉及 | 同步更新 |
|---|---|
| 配置字段（新增、改名、默认值、环境变量） | `docs/configuration.md`（重新生成）、`config.example.json`、**skill** |
| 新增可选能力 | `README.md`「可选能力」列表、`docs/architecture.md` §2 挂接点表（用了新挂接点时）、**skill**「可选能力默认关闭」 |
| 需要新的飞书权限或事件订阅 | `README.md`「飞书应用所需权限」 |
| 飞书命令（`src/commands/registry.ts`） | `README.md` 命令列表、**skill** |
| 日志事件名、`status.json` 字段、`/feishu doctor` 检查项 | `docs/operations.md` §1–2、**skill** §2–3 |
| 准入规则、`pipeline.drop` 的 reason / hint | `docs/operations.md` §3、**skill** §3 |
| 审批行为 | `docs/approval.md`、`docs/architecture.md` §6、**skill** |
| 新增 / 移动 / 拆分模块，模块依赖方向变化 | `docs/architecture.md` §2 |
| 消息路径的环节变化（入站、调度、出站） | `docs/architecture.md` §3、`README.md`「架构」图 |
| 不变量增删，或其实现 / 测试文件改名 | `docs/architecture.md` §4（表里写的是文件名）、`README.md`「架构」的不变式 |
| 会话键规则 | `docs/architecture.md` §5 |
| 发现新的飞书平台行为 | 先加进 `tests/integration/fake-feishu.ts` 再写测试，`docs/testing.md` 的假服务清单；CardKit 相关的写进 `README.md`「平台约束」 |
| 测试分层、测试工具变化 | `docs/testing.md` |
| 有取舍的设计决定（选了 A、否了 B） | `docs/development/decisions.md` 加一条 ADR |
| 修了一个用户能遇到的问题 | 是否该进 `docs/operations.md` §4 和 **skill**「常见症状速查」；问题已不存在时删掉对应条目 |

`docs/development/refactor-plan.md`、`progress.md` 只在做对应的结构重构时更新。

skill 是给 agent 用的速查：只写结论和操作步骤，细节链接到 `docs/`，不要把文档整段复制过去。
