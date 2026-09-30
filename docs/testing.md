# 测试

## 1. 命令

```bash
npm test          # 全部测试（单元 + 集成）
npm run lint      # tsc 未使用变量检查 + biome lint
npm run check     # lint + test，CI 执行的就是它
npm run metrics   # 结构指标（重构进度用，见 development/progress.md）

# 只跑一个文件
npx tsx --test tests/admit.test.ts
# 只跑名字匹配的用例
npx tsx --test --test-name-pattern "审批生命周期" tests/*.test.ts
```

CI（`.github/workflows/ci.yml`）在 Node 20 和 22 上执行 `npm run lint` 与 `npm test`。

## 2. 分层

从便宜到贵，越往下越接近真实环境：

| 层 | 位置 | 验证什么 | 依赖 |
|---|---|---|---|
| 单元 | `tests/*.test.ts` | 单个模块的行为：准入判定、分片边界、错误分类、审批状态机…… | 无 |
| 平台约束 | `tests/integration/platform-constraints.test.ts` | 飞书平台限制下的行为：编辑次数上限、撤回、限流、机器人不在群、流式卡片序号 | 飞书假服务 |
| 扩展入口 | `tests/integration/extension-entry.test.ts` | 从扩展入口驱动全部真实组件：卡片点击鉴权、工具审批检查、命令的管理员判定、群开通审批 | 飞书假服务 + 假 pi + 假会话后端（`extension-harness.ts`） |
| 可选能力 | `tests/features/*.test.ts` | 每项默认关闭的能力在「开 / 关」两种配置下的行为：关闭时不出现在 `features` 里、不产生该能力的日志；打开后命令与卡片可用 | 同扩展入口（`tests/features/helpers.ts`） |
| 可靠性矩阵 | `tests/integration/reliability-matrix.test.ts` | 用真实组件串起来的端到端链路：限流、只投递一次、崩溃恢复、权限错误 | 飞书假服务 + 假会话后端 |
| 审批转发端到端 | `scripts/e2e/ps-forwarding.ts` | 真实 pi + 真实 pi-permission-system 的转发审批链路（只有点卡片是模拟的），见 [approval.md](approval.md) §5 | 本机的 pi、pi-permission-system 和一个可用的模型 |
| 真实环境 | [operations.md](operations.md) §5 | 准入、路由、卡片渲染、真人点击 | 真实飞书应用 |

### 飞书假服务

`tests/integration/fake-feishu.ts` 在进程内模拟开放平台接口，按真实平台的约束应答：

- 同一条消息最多编辑 20 次，超出返回 230072；
- 回复已撤回的消息返回 230011，回复不存在的消息返回 231003；
- 机器人不在群里返回 230002；
- 可以注入限流：前 N 次写请求返回 99991400；
- 同一个 uuid 的创建请求是幂等的；
- 流式卡片按元素更新，sequence 必须递增，否则返回 300317。

目的是让测试验证「在平台约束下的行为」，而不只是「代码符合我们自己的假设」。新发现的平台行为应当先加进假服务，再写测试。

## 3. 写测试的约定

- **测试名用功能名做前缀**，例如 `审批生命周期：run 结束后旧卡失效，无法再授予 always`，测试输出里就能按功能分组。
- **断言要附上原因**：`assert.equal(x, y, "为什么必须这样")`，失败时不用回头读代码就知道约束是什么。
- **修缺陷先写复现测试**：先确认它在修复前失败，再修。
- **时间和随机数要注入**：模块普遍接受 `now` 参数，测试里不要依赖真实时钟和 sleep。
- **不访问网络，不依赖凭据**：需要平台行为时用飞书假服务。

## 4. 与重构的关系

重构期间每一项都要有**单独的测试命令**，并且每个提交都要能单独通过 `npm run check`。
各项的测试命令见 [development/progress.md](development/progress.md)。
