/**
 * API 错误统一归一化。
 *
 * 为什么要集中归一化：
 * - 异常路径（throw）也要读 `Retry-After` 响应头，否则限频等待会被忽略；
 * - 错误分类如果散落在 edit / media / post / reply 各自分支，
 *   权限类失败会和"目标已撤回/不可编辑"混在一起，被误当成可降级转发。
 *
 * 归一化产出三件事：
 * - `errorClass`：日志、统计与降级决策的依据；
 * - `retryable`：是否值得重试（限频/5xx/网络 true；权限/内容拒绝 false）；
 * - `retryAfterMs`：服务端明确要求的等待（header 秒数或 HTTP-date，或响应体 retry_after）。
 *
 * 说明：平台业务码只保留"已证实"的语义（撤回/不可用 → 允许路由回退），
 * 不照搬竞品的错误码清单；未知码一律按 unknown + 可重试处理，宁可多试一次也不静默丢弃。
 */

export type ApiErrorClass =
	/** 限频：按服务端 retry-after 等待后重试。 */
	| "rate_limited"
	/** 鉴权失败（token 失效等）。 */
	| "auth"
	/** 权限不足：重试与降级都无意义，且**不得**当成"允许转发"。 */
	| "permission"
	/** 目标不存在（消息已撤回/被删）。 */
	| "not_found"
	/** 目标不可用但消息本身存在（编辑目标失效等）。 */
	| "unavailable"
	/** 服务端错误。 */
	| "server"
	/** 网络/超时。 */
	| "network"
	/** 内容或参数被拒（可尝试降级为纯文本重发）。 */
	| "content_rejected"
	| "unknown";

export interface NormalizedApiError {
	errorClass: ApiErrorClass;
	retryable: boolean;
	retryAfterMs?: number;
	code?: number;
	status?: number;
	message: string;
}

/**
 * 平台业务码 → 允许路由回退（reply→create / edit→create）：仅限"目标不可用"语义。
 * 230011（被回复消息已撤回）与 231003（消息不存在）对齐 hermes `_FEISHU_REPLY_FALLBACK_CODES`：
 * 用户在机器人回复前撤回原消息是常见场景，缺了它们回复会一直重试到 failed。
 */
export const REPLY_FALLBACK_CODES: ReadonlySet<number> = new Set<number>([230003, 230004, 230005, 230007, 230008, 230011, 230018, 231003, 1001002]);

const RATE_LIMIT_HINT_RE = /(?:rate.?limit|too.?many|frequen|频控|限频|过于频繁)/i;
const NETWORK_HINT_RE = /(?:timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|aborted)/i;
const CONTENT_HINT_RE = /(?:invalid|illegal|param|content|post|format|unsupported)/i;

/**
 * 解析 Retry-After：支持秒数、毫秒字符串与 HTTP-date。
 * 返回毫秒等待时长；无法解析时返回 undefined。
 */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return undefined;
		// 数值一律按秒（HTTP 语义）；大于 1000 的极端值按毫秒容错。
		return value > 1_000 ? Math.round(value) : Math.round(value * 1_000);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return undefined;
		const asNumber = Number(trimmed);
		if (Number.isFinite(asNumber)) return parseRetryAfter(asNumber, now);
		const asDate = Date.parse(trimmed);
		if (Number.isFinite(asDate)) {
			const delta = asDate - now;
			return delta > 0 ? delta : 0;
		}
	}
	return undefined;
}

interface ErrorLike {
	message?: unknown;
	code?: unknown;
	status?: unknown;
	response?: {
		status?: unknown;
		headers?: Record<string, unknown>;
		data?: { code?: unknown; msg?: unknown; message?: unknown; retry_after?: unknown; retryAfter?: unknown };
	};
	headers?: Record<string, unknown>;
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	}
	return undefined;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): unknown {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

/**
 * 明确的权限/可见性业务码：重试不会自己变好（要人去改群成员、应用可用范围或 scope）。
 * - 230002 机器人不在群里；230006 机器人能力未启用；230013 用户不在应用可用范围；
 * - 230027 缺少必要权限；99991672 应用缺少接口 scope。
 * 这些码不能落到"未知错误 → 重试"：否则每条消息都会白白重试到上限。
 */
export const PERMISSION_CODES: ReadonlySet<number> = new Set([230002, 230006, 230013, 230027, 99991672]);

function classify(status: number | undefined, code: number | undefined, message: string): { errorClass: ApiErrorClass; retryable: boolean } {
	if (code !== undefined && PERMISSION_CODES.has(code)) return { errorClass: "permission", retryable: false };
	if (status === 429) return { errorClass: "rate_limited", retryable: true };
	if (status === 401) return { errorClass: "auth", retryable: false };
	if (status === 403) return { errorClass: "permission", retryable: false };
	if (status === 404) return { errorClass: "not_found", retryable: false };
	if (status !== undefined && status >= 500 && status < 600) return { errorClass: "server", retryable: true };
	if (RATE_LIMIT_HINT_RE.test(message)) return { errorClass: "rate_limited", retryable: true };
	if (code !== undefined && REPLY_FALLBACK_CODES.has(code)) return { errorClass: "unavailable", retryable: false };
	if (isEditExhausted(code, message)) return { errorClass: "unavailable", retryable: false };
	if (code !== undefined && (code === 99991400 || code === 99991401)) return { errorClass: "rate_limited", retryable: true };
	if (NETWORK_HINT_RE.test(message)) return { errorClass: "network", retryable: true };
	if (status === 400 || (code !== undefined && CONTENT_HINT_RE.test(message))) {
		return { errorClass: "content_rejected", retryable: false };
	}
	// 未知错误：宁可重试一次，也不静默丢弃（最终仍受 outbox maxAttempts 约束）。
	return { errorClass: "unknown", retryable: true };
}

/**
 * 归一化一个错误对象（throw 形态）。返回值同时覆盖 Retry-After header 与 body 字段。
 */
export function normalizeApiError(input: unknown, now: number = Date.now()): NormalizedApiError {
	const error = (typeof input === "object" && input !== null ? input : { message: String(input) }) as ErrorLike;
	const response = error.response;
	const status = firstNumber(response?.status, error.status, error.code);
	const code = firstNumber(response?.data?.code);
	const message = String(
		response?.data?.msg
		?? response?.data?.message
		?? (typeof error.message === "string" ? error.message : "")
		?? "",
	);

	const header = headerValue(response?.headers, "retry-after") ?? headerValue(error.headers, "retry-after");
	const bodyRetry = firstNumber(response?.data?.retry_after, response?.data?.retryAfter);
	const retryAfterMs = parseRetryAfter(header, now) ?? parseRetryAfter(bodyRetry, now);

	const verdict = classify(status, code, message);
	// 明确的 retry-after 说明这是可等待重试的场景（通常是限频）。
	if (retryAfterMs !== undefined && (verdict.errorClass === "unknown" || verdict.errorClass === "rate_limited")) {
		verdict.errorClass = "rate_limited";
		verdict.retryable = true;
	}
	return {
		errorClass: verdict.errorClass,
		retryable: verdict.retryable,
		retryAfterMs,
		code,
		status,
		message: message || `HTTP ${status ?? "?"} code ${code ?? "?"}`,
	};
}

/**
 * 归一化一个"非 0 业务码但 HTTP 成功"的响应体（return 形态）。
 */
export function normalizeApiResponse(response: unknown, now: number = Date.now()): NormalizedApiError {
	const body = (response ?? {}) as { code?: unknown; msg?: unknown; message?: unknown; retry_after?: unknown };
	const code = firstNumber(body.code);
	const message = String(body.msg ?? body.message ?? "");
	const retryAfterMs = parseRetryAfter(firstNumber(body.retry_after), now);
	const verdict = classify(undefined, code, message);
	if (retryAfterMs !== undefined && (verdict.errorClass === "unknown" || verdict.errorClass === "rate_limited")) {
		verdict.errorClass = "rate_limited";
		verdict.retryable = true;
	}
	return {
		errorClass: verdict.errorClass,
		retryable: verdict.retryable,
		retryAfterMs,
		code,
		status: undefined,
		message: message || `code ${code ?? "?"}`,
	};
}

/** 是否属于"目标不可用"（允许 reply→create / edit→create 路由回退）。 */
export function isReplyFallbackCode(code: number | undefined): boolean {
	return code !== undefined && REPLY_FALLBACK_CODES.has(code);
}

/**
 * 平台业务码 → 这条消息**不能再编辑**（编辑次数用完/超出可编辑时限/类型不支持编辑）。
 * 只影响 edit：命中后 final 改发新消息，而不是重试到 failed（线上 outbox 有一条因此丢失的 final）。
 */
export const EDIT_EXHAUSTED_CODES: ReadonlySet<number> = new Set<number>([230072, 230071, 230075]);
const EDIT_EXHAUSTED_HINT_RE = /(?:times it can be edited|can(?:not|'t) be edited|not editable|edit(?:ing)? (?:limit|time)|不可编辑|编辑次数)/i;

export function isEditExhausted(code: number | undefined, message?: string): boolean {
	if (code !== undefined && EDIT_EXHAUSTED_CODES.has(code)) return true;
	return Boolean(message && EDIT_EXHAUSTED_HINT_RE.test(message));
}

/**
 * Promise resolve ≠ 业务成功。HTTP 200 + 非 0 业务码必须按失败处理。
 * 抛出的错误带 `response.data`，下游 normalizeApiError 能照常分类（限频/不可用/内容被拒…）。
 * `undefined` 响应（client 不存在时 `?.request` 的结果）同样视为失败。
 */
export function assertApiOk<T>(response: T, label: string): T {
	if (response === undefined || response === null) throw new Error(`${label}: empty response`);
	const code = (response as { code?: unknown }).code;
	if (typeof code === "number" && code !== 0) {
		const msg = (response as { msg?: unknown }).msg;
		throw Object.assign(new Error(`${label}: ${code} ${typeof msg === "string" ? msg : ""}`.trim()), {
			response: { status: 200, data: response },
		});
	}
	return response;
}

/** 从 throw 或 return 两种形态里取业务码（用于回退判断）。 */
export function apiErrorCode(error: unknown): number | undefined {
	const data = (error as { response?: { data?: { code?: unknown } } })?.response?.data;
	return typeof data?.code === "number" ? data.code : undefined;
}
