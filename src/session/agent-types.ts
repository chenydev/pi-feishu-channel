/**
 * 会话句柄的类型别名。
 *
 * 单独一个模块，只因为 `ConversationManager` 与 `history-ops` 都要用它：
 * 放在管理器里会让它们互相 import（环形依赖），放在这里谁也不依赖谁。
 */
import type { SessionBackend } from "../types.js";

export type AgentHandle = Awaited<ReturnType<SessionBackend["createSession"]>>;
