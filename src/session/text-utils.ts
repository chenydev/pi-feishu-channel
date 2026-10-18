/** 注入的引用行里一定出现的特征词：只有复述这些内容的引用块才剥。 */
const INJECTED_QUOTE_MARKERS = ["正在回复的消息原文", "你正在回复自己上一条消息", "以下是用户回复"];

/**
 * 会话层的纯文本工具（RunExecutor 与 ConversationManager 共用，无状态）。
 */

/**
 * 剥离模型复述的注入提示（引用块 + 空行 + 原始用户消息残留）：
 * - 删除**复述注入内容**的开头 `> 引用` 块（模型自己写的引用属于回答，不删）
 * - 删除"以下是用户回复…"等引导句残留
 */
export function stripInjectedPrompt(text: string, quoteBlock: string): string {
	let out = text;
	// 精确剥离本次注入块（若被完整复述）
	if (quoteBlock && out.includes(quoteBlock)) out = out.replace(quoteBlock, "");
	// 兜底：模型把注入的引用改写成引用块（`> 正在回复的消息原文：…`）时一并剥掉。
	// 但只看「有没有复述注入内容」：模型自己以「> 结论：…」开头是正常的回答格式，
	// 无条件删开头引用块会把结论那句吃掉（“> 结论：应该加锁” → 只剩正文）。
	const leadingQuote = /^(?:> [^\n]*\n?)+/.exec(out)?.[0];
	if (leadingQuote && INJECTED_QUOTE_MARKERS.some((marker) => leadingQuote.includes(marker))) {
		out = out.slice(leadingQuote.length);
	}
	out = out.replace(/^\n+/, "");
	// 兜底：剥离 hermes 式回复注入残留（[正在回复…] / [你正在回复…] / 旧格式引导句）
	out = out.replace(/^\[(?:正在回复|你正在回复)[^\]]*\]\s*\n?/, "");
	out = out.replace(/^(以下是用户回复[^\n]*\n?)+/, "");
	out = out.replace(/^\[系统提示[^\]]*\]\s*\n?/, "");
	return out.trim();
}

/** 从事件 content 提取文本（pi 的 assistant message content 结构：string 或 [{type:'text',text}] 数组）。 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: string }).type === "text"
				? ((p as { text?: string }).text ?? "")
				: "",
		)
		.join("")
		.trim();
}

/** 从 agent 结果中提取助手文本（兼容字符串/含 message 的对象）。 */
export function extractAssistantText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (typeof r.text === "string" && r.text.trim()) return r.text;
		const msg = r.message as Record<string, unknown> | undefined;
		if (msg && typeof msg.text === "string" && msg.text.trim()) return msg.text;
	}
	return undefined;
}

/** 去掉桥注入在用户消息前的方括号上下文行（发言人、引用、群设定…）。 */
export function stripContextPrefix(text: string): string {
	return text.replace(/^(?:\[[^\n]*\][ \t]*\n+)+/, "").trim();
}

/** 列表/回执里的消息预览（单行、截断）。 */
export function previewText(text: string, max = 40): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "（附件）";
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
