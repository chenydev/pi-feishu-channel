/**
 * 澄清/选择提问（`feishu_ask`）的记录。
 *
 * 提问**不阻塞**：卡片发出后本轮就结束，点击选项等于以点击人身份往提问所在的会话发一条消息
 * （由卡片按钮处理，见 `interaction/card-ops.ts`）。所以这里没有等待点和超时，只记「哪些卡片还能点」：
 * - 每条记录绑定 token / 会话 / 群 / 卡片消息，跨群、旧卡、伪造值、无效选项一律拒绝；
 * - 一张卡只能答一次；同一会话发出新提问、会话重置（/new、切工作区）时旧卡失效；兜底有效期默认 24 小时；
 * - 记录落盘，重启后卡片仍然能点。
 * 与工具审批**完全独立**：选择只是一条普通消息，不授予任何工具权限。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ClarificationRecord {
	id: string;
	token: string;
	conversationKey: string;
	chatId: string;
	threadId?: string;
	chatType: "p2p" | "group" | "topic";
	/** 提问那一轮的发起人。 */
	askerId?: string;
	question: string;
	options: string[];
	cardMessageId?: string;
	createdAt: number;
	expiresAt: number;
}

export interface ClarificationRequest {
	conversationKey: string;
	chatId: string;
	threadId?: string;
	chatType?: "p2p" | "group" | "topic";
	askerId?: string;
	question: string;
	options: string[];
}

export interface ClarificationStoreDeps {
	/** 落盘文件；不设时只在内存里（测试用）。 */
	file?: string;
	/** 卡片有效期（毫秒，默认 24 小时；0 = 不设上限，只在新提问 / 会话重置时失效）。 */
	ttlMs?: number;
	onAudit?: (event: { clarificationId: string; conversationKey: string; question: string; decision: string; choice?: string; operatorOpenId?: string }) => void;
	now?: () => number;
}

export const DEFAULT_CLARIFY_TTL_MS = 24 * 3_600_000;
const MAX_OPTIONS = 4;
const STORE_VERSION = 1;

export class ClarificationStore {
	private records = new Map<string, ClarificationRecord>();
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(private deps: ClarificationStoreDeps = {}) {
		this.now = deps.now ?? Date.now;
		this.ttlMs = Math.max(0, deps.ttlMs ?? DEFAULT_CLARIFY_TTL_MS);
		this.load();
	}

	/** 新建一次提问：同一会话里还没答的旧提问一并失效（只认最新的那张卡）。 */
	create(input: ClarificationRequest): ClarificationRecord {
		const options = input.options.map((option) => option.trim()).filter(Boolean).slice(0, MAX_OPTIONS);
		if (options.length < 2) throw new Error("澄清提问至少需要 2 个选项");
		for (const old of [...this.records.values()]) {
			if (old.conversationKey === input.conversationKey) this.drop(old, "superseded");
		}
		this.pruneExpired();
		const now = this.now();
		const record: ClarificationRecord = {
			id: randomUUID(), token: randomUUID(),
			conversationKey: input.conversationKey, chatId: input.chatId,
			...(input.threadId ? { threadId: input.threadId } : {}),
			chatType: input.chatType ?? "group",
			...(input.askerId ? { askerId: input.askerId } : {}),
			question: input.question.slice(0, 500), options,
			createdAt: now, expiresAt: this.ttlMs > 0 ? now + this.ttlMs : Number.MAX_SAFE_INTEGER,
		};
		this.records.set(record.id, record);
		this.persist();
		return record;
	}

	/** 记录卡片消息 id（卡片发送成功后调用）。 */
	attachCard(id: string, cardMessageId: string | undefined): boolean {
		const record = this.records.get(id);
		if (!record || !cardMessageId) return false;
		record.cardMessageId = cardMessageId;
		this.persist();
		return true;
	}

	/** 卡片没发出去（改用文字提问）：删掉记录。 */
	discard(id: string): void {
		const record = this.records.get(id);
		if (record) this.drop(record, "card_failed");
	}

	/**
	 * 处理一次点击。先校验卡片本身（失效 / 跨群 / 旧卡 / 无效选项），再交给 `authorize` 判断点击人能不能作答
	 * （返回拒绝原因，或 undefined 表示可以）；都通过才消费这张卡。
	 */
	decide(input: {
		id: string; token: string; messageId: string; chatId: string; operatorOpenId: string; choice: string;
	}, authorize: (record: ClarificationRecord) => string | undefined = () => undefined): { ok: boolean; reason: string; record?: ClarificationRecord } {
		const record = this.records.get(input.id);
		if (!record) return { ok: false, reason: "这个提问已过期，直接回复文字即可" };
		if (this.now() > record.expiresAt) {
			this.drop(record, "expired");
			return { ok: false, reason: "这个提问已过期，直接回复文字即可" };
		}
		if (input.token !== record.token) return { ok: false, reason: "提问上下文不匹配" };
		if (record.cardMessageId && input.messageId !== record.cardMessageId) return { ok: false, reason: "提问上下文不匹配" };
		if (input.chatId !== record.chatId) return { ok: false, reason: "该提问不属于当前会话" };
		if (!record.options.includes(input.choice)) return { ok: false, reason: "无效选项" };
		const refused = authorize(record);
		if (refused) return { ok: false, reason: refused };
		this.records.delete(record.id);
		this.persist();
		this.deps.onAudit?.({
			clarificationId: record.id, conversationKey: record.conversationKey, question: record.question,
			decision: "answered", choice: input.choice, operatorOpenId: input.operatorOpenId,
		});
		return { ok: true, reason: `已选择：${input.choice}`, record };
	}

	/** 会话重置（/new、切工作区）→ 该会话的提问全部失效。 */
	cancelConversation(conversationKey: string): number {
		let cancelled = 0;
		for (const record of [...this.records.values()]) {
			if (record.conversationKey !== conversationKey) continue;
			this.drop(record, "conversation_reset");
			cancelled += 1;
		}
		return cancelled;
	}

	pendingCount(): number { return this.records.size; }

	/** 诊断快照（不含 token/question 全文）。 */
	snapshot(): Array<{ id: string; conversationKey: string; options: number; expiresAt: number }> {
		return [...this.records.values()].map((record) => ({
			id: record.id, conversationKey: record.conversationKey, options: record.options.length, expiresAt: record.expiresAt,
		}));
	}

	/**
	 * 清掉已过期的提问。
	 *
	 * 过期记录原来只在下一次访问到它时（点卡片）才删：没人点的提问会一直留在内存里，
	 * 长驻进程按「每天提过几次问」累积。`load()` 在启动时会滤掉过期项，这里补上运行期的清理。
	 */
	private pruneExpired(): void {
		const now = this.now();
		let pruned = 0;
		for (const record of [...this.records.values()]) {
			if (record.expiresAt >= now) continue;
			this.records.delete(record.id);
			pruned += 1;
			this.deps.onAudit?.({ clarificationId: record.id, conversationKey: record.conversationKey, question: record.question, decision: "expired" });
		}
		if (pruned > 0) this.persist();
	}

	private drop(record: ClarificationRecord, reason: string): void {
		this.records.delete(record.id);
		this.persist();
		this.deps.onAudit?.({ clarificationId: record.id, conversationKey: record.conversationKey, question: record.question, decision: reason });
	}

	private load(): void {
		if (!this.deps.file) return;
		try {
			const raw = JSON.parse(readFileSync(this.deps.file, "utf8")) as { records?: ClarificationRecord[] };
			const now = this.now();
			for (const record of raw?.records ?? []) {
				if (typeof record?.id !== "string" || typeof record.token !== "string" || typeof record.conversationKey !== "string"
					|| typeof record.chatId !== "string" || !Array.isArray(record.options) || typeof record.expiresAt !== "number") continue;
				if (record.expiresAt < now) continue;
				this.records.set(record.id, record);
			}
		} catch {
			// 文件不存在/损坏都当作空表：最坏是旧卡点不了，用户直接打字回复即可
			this.records.clear();
		}
	}

	private persist(): void {
		if (!this.deps.file) return;
		try {
			mkdirSync(dirname(this.deps.file), { recursive: true });
			const tmp = `${this.deps.file}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ version: STORE_VERSION, records: [...this.records.values()] }, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(tmp, this.deps.file);
		} catch {
			// 写盘失败只影响重启后旧卡能不能点，不影响本次
		}
	}
}

/**
 * 选项超过这个长度就不放进按钮：飞书按钮只显示一行，长了会被截断，看不出选的是什么。
 * 手机上整行按钮大约能放 14 个汉字。
 */
const BUTTON_LABEL_MAX = 14;

/**
 * 澄清卡片。选项都短：每个选项一个整行按钮；有长选项：正文列出带编号的完整选项（会换行），
 * 按钮只放编号、并排一行。点哪种按钮回调里都是完整的选项文本。
 */
export function buildClarificationCard(pending: ClarificationRecord): unknown {
	const numbered = pending.options.some((option) => option.length > BUTTON_LABEL_MAX);
	const buttons = pending.options.map((option, index) => ({
		tag: "button",
		text: { tag: "plain_text", content: numbered ? `选 ${index + 1}` : option },
		type: index === 0 ? "primary" : "default",
		width: "fill",
		value: { op: "clarify", clarificationId: pending.id, token: pending.token, choice: option },
	}));
	const question = { tag: "markdown", content: `**需要你确认**\n\n${pending.question}` };
	if (!numbered) return { schema: "2.0", body: { elements: [question, ...buttons] } };
	return {
		schema: "2.0",
		body: { elements: [
			question,
			{ tag: "markdown", content: pending.options.map((option, index) => `**${index + 1}.** ${option}`).join("\n") },
			{
				tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
				columns: buttons.map((button) => ({ tag: "column", width: "weighted", weight: 1, elements: [button] })),
			},
		] },
	};
}

/** 无卡片权限时的文本回退文案（用户直接回复文字即可）。 */
export function clarificationTextFallback(record: Pick<ClarificationRecord, "question" | "options">): string {
	const lines = record.options.map((option, index) => `${index + 1}. ${option}`);
	return `**需要你确认**\n\n${record.question}\n\n${lines.join("\n")}\n\n（直接回复选项编号或文字即可）`;
}

/** 点击后卡片变成结果：问题、谁选了什么。 */
export function buildClarificationResultCard(question: string, choice: string, operatorOpenId: string): unknown {
	return { schema: "2.0", body: { elements: [{ tag: "markdown", content: `**${question}**\n\n<at id=${operatorOpenId}></at> 选择了：${choice}` }] } };
}

/** 点击选项后进入会话的消息正文（模型据此继续）。 */
export function clarificationAnswerText(question: string, choice: string): string {
	return `[选择] ${choice}\n（回答你的提问：${question}）`;
}
