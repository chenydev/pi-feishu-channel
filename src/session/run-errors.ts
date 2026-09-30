/**
 * 把 run 失败原因翻译成面向用户的提示 + 下一步建议。
 *
 * 原始错误（提供方返回体、内部异常文本）只写日志，群里只看到类别文案和错误编号 ——
 * 编号与日志里的 `errorId` 对得上，排查时按编号 grep 即可。
 */

export type RunErrorCategory = "aborted" | "rate_limit" | "context_overflow" | "auth" | "network" | "provider" | "unknown";

export interface ClassifiedRunError {
	category: RunErrorCategory;
	/** 给用户看的整句（以"处理出错："开头，便于在群里一眼识别）。 */
	text: string;
}

const RULES: Array<{ category: RunErrorCategory; pattern: RegExp }> = [
	{ category: "aborted", pattern: /\baborted\b|AbortError|operation was aborted|request was cancelled/i },
	{ category: "rate_limit", pattern: /\b429\b|rate.?limit|too many requests|quota|overloaded|\b529\b|RESOURCE_EXHAUSTED/i },
	{ category: "context_overflow", pattern: /context.{0,20}(length|window|limit|too long)|maximum context|too many tokens|prompt is too long|input.{0,10}too long|exceeds.{0,20}(context|token)/i },
	{ category: "auth", pattern: /\b401\b|\b403\b|unauthori[sz]ed|invalid.{0,10}api.?key|authentication|permission denied|forbidden|no api key/i },
	{ category: "network", pattern: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timed? ?out/i },
	{ category: "provider", pattern: /\b5\d\d\b|internal server error|bad gateway|service unavailable|upstream/i },
];

export function classifyRunError(message: string, errorId: string): ClassifiedRunError {
	const category = RULES.find((rule) => rule.pattern.test(message))?.category ?? "unknown";
	const suffix = `（错误编号 ${errorId}）`;
	switch (category) {
		case "aborted":
			return { category, text: "处理出错：任务已被中止。需要的话直接重发，或用 /retry 重试上一条。" };
		case "rate_limit":
			return { category, text: `处理出错：模型服务限流或额度不足，请稍后重试；也可以用 /model 换个模型后 /retry。${suffix}` };
		case "context_overflow":
			return { category, text: `处理出错：对话上下文超出模型上限。用 /compact 压缩上下文，或 /new 开新会话后再试。${suffix}` };
		case "auth":
			return { category, text: `处理出错：模型服务鉴权失败（密钥无效或无权限），请联系管理员检查模型配置。${suffix}` };
		case "network":
			return { category, text: `处理出错：连接模型服务失败（网络问题），请稍后用 /retry 重试。${suffix}` };
		case "provider":
			return { category, text: `处理出错：模型服务暂时不可用，请稍后用 /retry 重试，或 /model 换个模型。${suffix}` };
		default:
			return { category, text: `处理出错：任务执行失败，请重试；如果反复出现请把错误编号发给管理员。${suffix}` };
	}
}

/** 短错误编号（日志与群消息对照用；不需要全局唯一，只要一段时间内能区分）。 */
export function newErrorId(now: number = Date.now()): string {
	return `E${(now % 1e8).toString(36).toUpperCase()}${Math.floor(Math.random() * 36 * 36).toString(36).toUpperCase().padStart(2, "0")}`;
}
