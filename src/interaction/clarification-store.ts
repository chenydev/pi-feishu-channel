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
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../runtime/atomic-file.js";

/** 一张卡里的一个问题。 */
export interface ClarificationQuestion {
	/** 稳定的键（q1、q2…）：表单控件的 name 和回传值都用它。 */
	id: string;
	question: string;
	options: string[];
	/** 可以选多个（多选控件 + 「提交」一次回传）。 */
	multiSelect?: boolean;
	/** 推荐哪些选项（下标）：卡片上打 ⭐，并在题下写一句为什么。 */
	recommended?: number[];
	/** 为什么推荐这些（一两句，显示在题目标题下面）。 */
	reason?: string;
	/**
	 * 允许自填（表单里的输入框）。表单卡本来就每题都带自填框；
	 * 这个字段的作用是**把单题单选也拉进表单**（否则它就是「点一下即答」的按钮卡）。
	 */
	allowOther?: boolean;
}

/** 用户对一道题的作答。 */
export interface ClarificationAnswer {
	question: string;
	/** 选中的选项（多选时多个）。 */
	choices: string[];
	/** 自己填的内容（`allowOther` 且填了才有）。 */
	other?: string;
}

export interface ClarificationRecord {
	/** 见 `ClarificationRequest.radio`。 */
	radio?: boolean;
	id: string;
	token: string;
	conversationKey: string;
	chatId: string;
	threadId?: string;
	chatType: "p2p" | "group" | "topic";
	/** 提问那一轮的发起人。 */
	askerId?: string;
	/** 第一题的问题与选项（v1 字段：单题快路径与旧记录都靠它）。 */
	question: string;
	options: string[];
	/** 一卡多题；单题时为空（用上面的 question/options）。 */
	questions?: ClarificationQuestion[];
	/** 用折叠面板收纳每道题（飞书客户端 ≥ 7.9；低版本只显示占位）。 */
	panels?: boolean;
	cardMessageId?: string;
	createdAt: number;
	expiresAt: number;
}

export interface ClarificationRequest {
	/**
	 * 单题单选时用「勾选式单选」：选项是复选框，点一下即答（不用按钮）。
	 * 视觉上更像表单，长选项换行比按钮好看；点击后照样走 `clarify` 那条路径。
	 */
	radio?: boolean;
	conversationKey: string;
	chatId: string;
	threadId?: string;
	chatType?: "p2p" | "group" | "topic";
	askerId?: string;
	question?: string;
	options?: string[];
	/** 单题形态下的多选 / 自填 / 推荐（等价于把它们写在 questions[0] 上）。 */
	multiSelect?: boolean;
	allowOther?: boolean;
	recommended?: number[];
	reason?: string;
	/** 用折叠面板收纳每道题（飞书客户端 ≥ 7.9；`false` = 平铺）。 */
	panels?: boolean;
	/** 一卡多题（1-4 题）。给了这个就忽略上面的 question/options；`id` 缺省按 q1、q2… 生成。 */
	questions?: Array<Omit<ClarificationQuestion, "id"> & { id?: string }>;
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
		const questions = normalizeQuestions(input);
		const options = questions[0]!.options;
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
			question: questions[0]!.question, options,
			questions,
			...(requestsNoPanels(input) ? { panels: false } : {}),
			...(input.radio ? { radio: true } : {}),
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

	/** 按卡片消息找记录（表单提交的回调里不一定带得回 value）。 */
	findByMessage(messageId: string): ClarificationRecord | undefined {
		for (const record of this.records.values()) if (record.cardMessageId === messageId) return record;
		return undefined;
	}

	/** 这道题是不是多选（记录里缺省 = 单选）。 */
	questionsOf(record: ClarificationRecord): ClarificationQuestion[] {
		return record.questions?.length ? record.questions : [{ id: "q1", question: record.question, options: record.options }];
	}

	/**
	 * 表单提交：一次校验整张卡的所有问题。
	 *
	 * 校验顺序与 `decide` 一致（卡片有效 → 点击人有权限 → 作答合法），区别是：
	 * - 表单回传的是「题号 → 值」的映射，按记录里的题目逐题校验，不信任任何未声明的题号/选项；
	 * - 允许「只选了选项」或「只自己填」，也可以两者都有；
	 * - 多选值可以是字符串数组。
	 */
	decideForm(input: {
		messageId: string; chatId: string; operatorOpenId: string; values: Record<string, unknown>;
		id?: string; token?: string;
	}, authorize: (record: ClarificationRecord) => string | undefined = () => undefined): {
		ok: boolean; reason: string; record?: ClarificationRecord; answers?: ClarificationAnswer[];
	} {
		const record = input.id ? this.records.get(input.id) : this.findByMessage(input.messageId);
		if (!record) return { ok: false, reason: "这个提问已过期，直接回复文字即可" };
		if (this.now() > record.expiresAt) {
			this.drop(record, "expired");
			return { ok: false, reason: "这个提问已过期，直接回复文字即可" };
		}
		if (input.token !== undefined && input.token !== record.token) return { ok: false, reason: "提问上下文不匹配" };
		if (record.cardMessageId && input.messageId !== record.cardMessageId) return { ok: false, reason: "提问上下文不匹配" };
		if (input.chatId !== record.chatId) return { ok: false, reason: "该提问不属于当前会话" };
		const refused = authorize(record);
		if (refused) return { ok: false, reason: refused };

		const answers: ClarificationAnswer[] = [];
		for (const question of this.questionsOf(record)) {
			const picked = pickedOptions(input.values, question);
			for (const entry of picked) if (!question.options.includes(entry)) return { ok: false, reason: "无效选项" };
			const otherRaw = input.values[`${question.id}__other`];
			const other = typeof otherRaw === "string" ? otherRaw.trim().slice(0, 500) : "";
			if (picked.length === 0 && !other) return { ok: false, reason: `还有问题没作答：${question.question}` };
			if (picked.length > 1 && !question.multiSelect) {
				// 说清「勾了哪几个」：toast 只闪一下，用户得知道回去取消哪一个
				return { ok: false, reason: `「${question.question}」只能选一个，现在勾了 ${picked.length} 个（${picked.join("、")}）—— 取消其中一个再提交` };
			}
			answers.push({ question: question.question, choices: picked, ...(other ? { other } : {}) });
		}
		this.records.delete(record.id);
		this.persist();
		this.deps.onAudit?.({
			clarificationId: record.id, conversationKey: record.conversationKey, question: record.question,
			decision: "answered", choice: answers.map((answer) => [...answer.choices, ...(answer.other ? [answer.other] : [])].join("、")).join("；"),
			operatorOpenId: input.operatorOpenId,
		});
		return { ok: true, reason: "已提交", record, answers };
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
			atomicWriteJson(this.deps.file, { version: STORE_VERSION, records: [...this.records.values()] });
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

/** 调用方显式要求平铺（老客户端没有折叠面板）。 */
function requestsNoPanels(input: ClarificationRequest): boolean {
	return (input as { panels?: boolean }).panels === false;
}

/** 题目上限：一张卡塞太多题会很长，且没人愿意一次答十几道。 */
const MAX_QUESTIONS = 4;

/**
 * 从表单回传值里还原「这道题选了哪些选项」。
 *
 * 两种控件形态都要认：
 * - 按题聚合的值（`values[q1] = "A"` 或 `["A","B"]`，下拉/多选下拉）；
 * - 每个选项一个复选框（`values["q1__opt0"] = true`，当前卡片用的形态）。
 * 复选框按**位置**还原：选项文本可以带空格标点，不适合当键。
 */
function pickedOptions(values: Record<string, unknown>, question: ClarificationQuestion): string[] {
	const out: string[] = [];
	const aggregated = values[question.id];
	const entries = Array.isArray(aggregated) ? aggregated : typeof aggregated === "string" && aggregated ? [aggregated] : [];
	for (const entry of entries) {
		// 下拉控件的值可能是 {value} 包装
		const value = typeof entry === "object" && entry ? (entry as { value?: unknown }).value : entry;
		if (typeof value === "string" && question.options.includes(value) && !out.includes(value)) out.push(value);
	}
	for (const [index, option] of question.options.entries()) {
		if (values[checkboxName(question.id, index)] === true && !out.includes(option)) out.push(option);
	}
	return out;
}

/**
 * 把两种入参统一成题目数组：`questions`（多题）或 `question` + `options`（单题）。
 * 校验放在这里，工具层只负责把用户输入转成结构化形式。
 */
function normalizeQuestions(input: ClarificationRequest): ClarificationQuestion[] {
	// 单题形态（question + options）也要带上顶层的 multiSelect / recommended / reason，
	// 否则「单题多选」会被悄悄降级成按钮卡。
	const raw = (input.questions?.length
		? input.questions
		: [{
			id: "q1",
			question: input.question ?? "",
			options: input.options ?? [],
			...(input.multiSelect ? { multiSelect: true } : {}),
			...(input.allowOther ? { allowOther: true } : {}),
			...(input.recommended ? { recommended: input.recommended } : {}),
			...(input.reason ? { reason: input.reason } : {}),
		}]) as ClarificationQuestion[];
	if (raw.length > MAX_QUESTIONS) throw new Error(`一次最多问 ${MAX_QUESTIONS} 个问题`);
	const seen = new Set<string>();
	return raw.map((item, index) => {
		const id = item.id && !seen.has(item.id) ? item.id : `q${index + 1}`;
		seen.add(id);
		const question = String(item.question ?? "").trim().slice(0, 500);
		if (!question) throw new Error("问题不能为空");
		const options = (item.options ?? []).map((option) => String(option).trim()).filter(Boolean).slice(0, MAX_OPTIONS);
		if (options.length < 2) throw new Error("每题至少需要 2 个选项");
		const recommended = Array.isArray(item.recommended)
			? item.recommended.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < options.length)
			: [];
		const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 300) : "";
		return {
			id, question, options,
			...(item.multiSelect ? { multiSelect: true } : {}),
			...(item.allowOther ? { allowOther: true } : {}),
			...(recommended.length > 0 ? { recommended } : {}),
			...(recommended.length > 0 && reason ? { reason } : {}),
		};
	});
}

/**
 * 澄清卡片。选项都短：每个选项一个整行按钮；有长选项：正文列出带编号的完整选项（会换行），
 * 按钮只放编号、并排一行。点哪种按钮回调里都是完整的选项文本。
 */
/**
 * 勾选式单选：选项是复选框，点一下就走 `clarify`（和按钮卡同一条路径：立即作答 + 卡片转只读）。
 * 飞书没有单选按钮组件，这是最接近「radio」的形态 —— 表现上就是「勾一个」，不用再点提交。
 */
function buildRadioCard(pending: ClarificationRecord): unknown {
	const only = questionsOfRecord(pending)[0]!;
	const recommended = new Set(only.recommended ?? []);
	const elements: unknown[] = [
		// 单题不再加「需要你确认」这种套话：问题本身就是标题
		{ tag: "markdown", content: `**${pending.question}**` },
		...(only.reason ? [{ tag: "markdown", content: `<font color='grey'>💡 ${only.reason}</font>` }] : []),
		...pending.options.map((option, index) => ({
			tag: "checker",
			name: checkboxName("q1", index),
			checked: false,
			// 勾上就回调：没有提交按钮，点一下即答
			behaviors: [{ type: "callback", value: { op: "clarify", clarificationId: pending.id, token: pending.token, choice: option } }],
			text: { tag: "plain_text", content: recommended.has(index) ? `⭐ ${option}（推荐）` : option },
		})),
	];
	return { schema: "2.0", body: { elements } };
}

export function buildClarificationCard(pending: ClarificationRecord): unknown {
	const questions = pending.questions?.length ? pending.questions : [{ id: "q1", question: pending.question, options: pending.options }];
	const form = questions.length > 1 || questions.some((question) => question.multiSelect || question.allowOther);
	if (form) return buildFormCard(pending, questions, { panels: pending.panels !== false });
	// 勾选式单选：选项长到放不进按钮（> BUTTON_LABEL_MAX）时直接平铺复选框 ——
	// 原来是「编号列表 + 选 1/选 2」，既丑又要来回对照。`radio` 参数可强制走这个形态。
	const numbered = pending.options.some((option) => option.length > BUTTON_LABEL_MAX);
	if (pending.radio || numbered) return buildRadioCard(pending);
	const only = questions[0]!;
	const recommended = new Set(only.recommended ?? []);
	const buttons = pending.options.map((option, index) => ({
		tag: "button",
		// 整行按钮只吃纯文本：推荐直接写在文案里（⭐ + 「推荐」）
		text: { tag: "plain_text", content: recommended.has(index) ? `⭐ ${option}（推荐）` : option },
		type: recommended.has(index) || (recommended.size === 0 && index === 0) ? "primary" : "default",
		width: "fill",
		value: { op: "clarify", clarificationId: pending.id, token: pending.token, choice: option },
	}));
	const question = { tag: "markdown", content: `**需要你确认**\n\n${pending.question}` };
	const reason = only.reason ? { tag: "markdown", content: `<font color='grey'>💡 ${only.reason}</font>` } : undefined;
	return { schema: "2.0", body: { elements: [question, ...(reason ? [reason] : []), ...buttons] } };
}

/**
 * 一卡多题（或需要多选/自填）的表单卡。
 *
 * 为什么用 `form` + 提交按钮而不是「点一下就改卡」：一次点击把所有控件值一次性回传
 * （`action.form_value`），既不烧卡片编辑配额，也不会在手机上闪。
 * 单题、单选、选项都短时仍走上面的「整行按钮」快路径 —— 那是最少点击的形态。
 */
function buildFormCard(pending: ClarificationRecord, questions: ClarificationQuestion[], options: { panels?: boolean } = {}): unknown {
	const usePanels = options.panels ?? true;
	const elements: unknown[] = [{ tag: "markdown", content: questions.length > 1 ? `**需要你确认**（${questions.length} 题）` : "**需要你确认**" }];
	const controls: unknown[] = [];
	for (const [index, question] of questions.entries()) {
		// 单选也走复选框：下拉在长选项下很难看（选项文字被截进一个窄框），平铺勾选更直观。
		// 代价是复选框互不联动，单选靠标题提示 + 提交时的服务端校验（提示会说清勾了哪几个）。
		const recommended = new Set(question.recommended ?? []);
		const body: unknown[] = question.options.map((option, optionIndex) => ({
			tag: "checker", name: checkboxName(question.id, optionIndex), checked: false,
			// 复选框只吃纯文本：推荐标记直接写进文案（⭐ + 「推荐」），理由写在题目下面一行
			text: { tag: "plain_text", content: recommended.has(optionIndex) ? `⭐ ${option}（推荐）` : option },
		}));
		// 每题都带一个自填框：用户想补充的往往不在选项里，少一次「另发一条消息」。
		body.push({
			tag: "input", name: `${question.id}__other`,
			placeholder: { tag: "plain_text", content: "其他（可直接填写）" },
		});
		const title = `${questions.length > 1 ? `Q${index + 1} · ` : ""}${question.question}${question.multiSelect ? "（多选）" : "（单选 · 只勾一个）"}`;
		// 题目之间用分割线隔开：折叠面板收起时边界很淡，多题容易连成一片
		if (index > 0) controls.push({ tag: "hr" });
		// 推荐理由放进表单元素里（放在复选框之前），老客户端也能看到
		if (question.reason) body.unshift({ tag: "markdown", content: `<font color='grey'>💡 ${question.reason}</font>` });
		controls.push(usePanels
			? {
				tag: "collapsible_panel", expanded: true, vertical_spacing: "8px",
				header: { title: { tag: "markdown", content: title }, vertical_align: "center" },
				elements: body,
			}
			: { tag: "markdown", content: `**${title}**` });
		if (!usePanels) controls.push(...body);
	}
	controls.push({ tag: "markdown", content: "<font color='grey'>每题至少勾一项或自填；标「单选」的只能勾一个</font>" });
	controls.push({
		tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
		columns: [
			{
				tag: "column", width: "weighted", weight: 1, elements: [{
					tag: "button", name: "submit", type: "primary", width: "fill",
					// 表单里的按钮认 `form_action_type`（不写 behaviors）；value 带身份，回调缺 form_value 时也能定位
					form_action_type: "submit",
					text: { tag: "plain_text", content: "提交" },
					value: { op: "clarify_submit", clarificationId: pending.id, token: pending.token },
				}],
			},
			{
				tag: "column", width: "weighted", weight: 1, elements: [{
					tag: "button", name: "reset", type: "default", width: "fill",
					form_action_type: "reset",
					text: { tag: "plain_text", content: "重置" },
				}],
			},
		],
	});
	elements.push({ tag: "form", name: "clarify_form", elements: controls });
	return { schema: "2.0", body: { elements } };
}

/** 复选框的 `name`：`q1__opt0`。位置而不是文本当键 —— 选项文本可以有空格/标点/超长。 */
export function checkboxName(questionId: string, optionIndex: number): string {
	return `${questionId}__opt${optionIndex}`;
}

/** 无卡片权限时的文本回退文案（用户直接回复文字即可）。 */
export function clarificationTextFallback(record: Pick<ClarificationRecord, "question" | "options" | "questions">): string {
	const questions = record.questions?.length ? record.questions : [{ id: "q1", question: record.question, options: record.options, multiSelect: false }];
	const blocks = questions.map((question, index) => {
		const head = questions.length > 1 ? `${index + 1}. ${question.question}${question.multiSelect ? "（可多选）" : ""}` : question.question;
		const recommended = new Set(question.recommended ?? []);
		const lines = question.options.map((option, optionIndex) => `   ${optionIndex + 1}. ${recommended.has(optionIndex) ? `⭐ ${option}（推荐）` : option}`);
		// 没法打按钮的形态也要能看出「建议选哪个」，否则用户只能凭感觉
		if (recommended.size > 0 && question.reason) lines.push(`   💡 ${question.reason}`);
		return [head, ...lines].join("\n");
	});
	return `**需要你确认**\n\n${blocks.join("\n\n")}\n\n（直接回复选项编号或文字即可）`;
}

/**
 * 作答后的卡片：**留在原地变只读**，不再换成一段结果摘要。
 *
 * 原来的做法是把整张卡替换成「谁选了什么」的两行摘要 —— 提问本身和没选的选项一起消失，
 * 群里回看时看不出「当时问的是什么、还给了哪些选项」。现在保留原结构：
 * 问题、全部选项（选中的打勾）、自填内容，只是复选框禁用、按钮撤掉。
 */
export function buildAnsweredCard(input: {
	questions: ClarificationQuestion[];
	answers: ClarificationAnswer[];
	operatorOpenId: string;
	/** 用折叠面板收纳（与提问卡保持一致；单题或显式关闭时平铺）。 */
	panels?: boolean;
}): unknown {
	const { questions, answers, operatorOpenId } = input;
	const answeredAt = new Map(answers.map((answer) => [answer.question, answer]));
	const usePanels = (input.panels ?? true) && questions.length > 1;
	const elements: unknown[] = [{
		tag: "markdown",
		content: `<at id=${operatorOpenId}></at> ✅ 已作答`,
	}];
	for (const [index, question] of questions.entries()) {
		const answer = answeredAt.get(question.question);
		const picked = new Set(answer?.choices ?? []);
		const recommended = new Set(question.recommended ?? []);
		const checked = question.options.map((option, optionIndex) => ({
			tag: "checker",
			// 同一个 name 重绘不会触发回调（没有 form、没有 behaviors），只用来保持结构一致
			name: checkboxName(question.id, optionIndex),
			checked: picked.has(option),
			disabled: true,
			text: { tag: "plain_text", content: recommended.has(optionIndex) ? `⭐ ${option}（推荐）` : option },
		}));
		const body: unknown[] = [...checked];
		if (answer?.other) {
			// 输入框不能只读，改成一行灰字（保留用户当时填的内容）
			body.push({ tag: "markdown", content: `<font color='grey'>其他：${answer.other}</font>` });
		}
		const summary = answer ? formatAnswer(answer) : "（未答）";
		const title = `${questions.length > 1 ? `Q${index + 1} · ` : ""}${question.question}${question.multiSelect ? "（多选）" : "（单选）"}`;
		if (index > 0) elements.push({ tag: "hr" });
		elements.push(usePanels
			? {
				// 收起：群里回看时先看到「答了什么」，想看全部选项再点开
				tag: "collapsible_panel", expanded: false, vertical_spacing: "8px",
				header: { title: { tag: "markdown", content: `${title} —— ✅ ${summary}` } },
				elements: body,
			}
			: { tag: "markdown", content: `**${title}** —— ✅ ${summary}` });
		if (!usePanels) elements.push(...body);
	}
	return { schema: "2.0", body: { elements } };
}

/** 点击后卡片留在原地变只读（单题：沿用提问卡的按钮顺序）。 */
export function buildClarificationResultCard(question: string, choice: string, operatorOpenId: string, options?: string[]): unknown {
	const list = options ?? [];
	return buildAnsweredCard({
		questions: [{ id: "q1", question, options: list.includes(choice) ? list : [choice, ...list] }],
		answers: [{ question, choices: [choice] }],
		operatorOpenId,
	});
}

/** 一题答案的展示文本：「登录、下单（自填：只跑冒烟）」。 */
export function formatAnswer(answer: ClarificationAnswer): string {
	const picked = answer.choices.join("、");
	if (answer.other) return picked ? `${picked}（自填：${answer.other}）` : `自填：${answer.other}`;
	return picked;
}

/** 作答后要重绘的卡片：把记录里的题目（含没选的选项）连同答案一起交给 `buildAnsweredCard`。 */
export function answeredCardFor(record: ClarificationRecord, answers: ClarificationAnswer[], operatorOpenId: string): unknown {
	return buildAnsweredCard({
		questions: questionsOfRecord(record),
		answers,
		operatorOpenId,
		panels: record.panels !== false,
	});
}

/** 题目列表（旧记录没有 `questions` 时按单题还原）。 */
export function questionsOfRecord(record: ClarificationRecord): ClarificationQuestion[] {
	if (record.questions?.length) return record.questions;
	return [{ id: "q1", question: record.question, options: record.options }];
}

/** 点击选项后进入会话的消息正文（模型据此继续）。 */
export function clarificationAnswerText(question: string, choice: string): string {
	return `[选择] ${choice}\n（回答你的提问：${question}）`;
}

/**
 * 表单提交后进入会话的消息正文：一题时沿用 `[选择] X` 的形态（模型对它的理解已被
 * 提示词对齐），多题时逐题列出，模型一眼能读到「哪一题答了什么」。
 */
export function clarificationAnswersText(answers: ClarificationAnswer[]): string {
	if (answers.length === 1) {
		const [answer] = answers;
		const text = formatAnswer(answer!);
		return clarificationAnswerText(answer!.question, text);
	}
	const label = (question: string): string => question.replace(/[？?：:\s]+$/u, "");
	const lines = answers.map((answer) => `- ${label(answer.question)}：${formatAnswer(answer)}`);
	return `[选择] 共 ${answers.length} 题\n${lines.join("\n")}\n（以上是用户对提问的作答）`;
}
