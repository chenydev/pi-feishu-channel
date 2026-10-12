/**
 * pi 扩展 API 最小本地类型声明（运行时由 pi 提供，结构兼容官方 pi 0.84.x）。
 * 只使用官方确认导出的 API；本地声明保持独立 typecheck。
 */
export interface ExtensionUI {
	setStatus(key: string, text: string): void;
	notify(message: string, type?: "warning" | "info" | "error"): void;
}

export interface ExtensionCommandContext {
	cwd: string;
	session: unknown;
}

export interface ExtensionRuntimeContext {
	cwd: string;
	sessionManager: { getSessionId(): string };
	/** 界面只挂在事件的 ctx 上，不在 ExtensionAPI 上；没有界面时（print 模式）是空实现。 */
	ui?: ExtensionUI;
}

export interface ExtensionToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	isError?: boolean;
}

/**
 * 注意：pi 的 ExtensionAPI 上没有 `getAgentDir` / `getPackageDir` / `ui`。
 * 前两个是 `@earendil-works/pi-coding-agent` 的模块导出（见 runtime/agent-dir.ts），`ui` 在事件 ctx 上。
 * tests/pi-api.test.ts 在编译期核对这里的每个成员都真实存在。
 */
export interface ExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: ExtensionRuntimeContext) => unknown | Promise<unknown>): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: Record<string, unknown>;
		execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionRuntimeContext): Promise<ExtensionToolResult>;
	}): void;
	registerCommand(
		name: string,
		opts: {
			description?: string;
			handler: (args: string, ctx: ExtensionCommandContext, argsList: string[]) => string | Promise<string>;
		},
	): void;
	appendEntry(customType: string, data: unknown): void;
	/** 已注册的斜杠命令（扩展命令、prompt 模板、技能）；老版本 pi 没有。 */
	getCommands?(): Array<{ name: string; description?: string; source?: "extension" | "prompt" | "skill" | string }>;
}
