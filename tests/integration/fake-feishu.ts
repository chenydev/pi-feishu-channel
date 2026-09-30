/**
 * 模拟飞书开放平台的假服务（进程内，按 rawRequest 形状应答）。
 *
 * 目的是让测试验证"平台约束下的行为"，而不只是"我们对自己实现的假设"。已实现的约束：
 * - 同一条消息最多编辑 20 次，超出返回 230072；
 * - 回复一条已撤回/不存在的消息返回 230011（撤回）/ 231003（不存在）；
 * - 机器人不在群里返回 230002；
 * - 可注入限流：前 N 次写请求返回 99991400；
 * - 同一 uuid 的创建请求幂等（返回同一条消息）；
 * - CardKit：卡片实体、按元素流式更新（sequence 必须递增，否则 300317）。
 */

export interface FakeMessage {
	id: string;
	chatId: string;
	msgType: string;
	content: string;
	replyTo?: string;
	edits: number;
	recalled: boolean;
}

export class FakeFeishu {
	readonly messages = new Map<string, FakeMessage>();
	readonly cards = new Map<string, { elements: Map<string, string>; sequence: number }>();
	readonly calls: Array<{ method: string; url: string }> = [];
	private seq = 0;
	private byUuid = new Map<string, string>();
	/** 前 N 次写请求限流。 */
	rateLimitNext = 0;
	/** 机器人不在这些群里。 */
	notInChats = new Set<string>();

	private ok(data: unknown = {}) { return { code: 0, msg: "success", data }; }
	private fail(code: number, msg: string) { return { code, msg }; }

	private create(chatId: string, msgType: string, content: string, uuid?: string, replyTo?: string): unknown {
		if (this.notInChats.has(chatId)) return this.fail(230002, "Bot/User can NOT be out of the chat.");
		if (uuid && this.byUuid.has(uuid)) return this.ok({ message_id: this.byUuid.get(uuid) });
		const id = `om_fake_${++this.seq}`;
		this.messages.set(id, { id, chatId, msgType, content, replyTo, edits: 0, recalled: false });
		if (uuid) this.byUuid.set(uuid, id);
		return this.ok({ message_id: id });
	}

	recall(messageId: string): void {
		const message = this.messages.get(messageId);
		if (message) message.recalled = true;
	}

	visibleTexts(chatId?: string): string[] {
		return [...this.messages.values()]
			.filter((message) => !message.recalled && (!chatId || message.chatId === chatId))
			.map((message) => message.content);
	}

	rawRequest = async (opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> => {
		this.calls.push({ method: opts.method, url: opts.url });
		const data = (opts.data ?? {}) as Record<string, unknown>;
		if (opts.method !== "GET" && this.rateLimitNext > 0) {
			this.rateLimitNext -= 1;
			return this.fail(99991400, "request trigger frequency limit");
		}
		let match: RegExpExecArray | null;
		if (opts.method === "POST" && opts.url === "/open-apis/im/v1/messages") {
			return this.create(String(data.receive_id), String(data.msg_type), String(data.content), data.uuid as string | undefined);
		}
		match = opts.method === "POST" ? /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(opts.url) : null;
		if (match) {
			const parent = this.messages.get(match[1]);
			if (!parent) return this.fail(231003, "The message is not found");
			if (parent.recalled) return this.fail(230011, "The message was withdrawn.");
			return this.create(parent.chatId, String(data.msg_type), String(data.content), data.uuid as string | undefined, parent.id);
		}
		match = (opts.method === "PUT" || opts.method === "PATCH") ? /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(opts.url) : null;
		if (match) {
			const message = this.messages.get(match[1]);
			if (!message || message.recalled) return this.fail(231003, "The message is not found");
			if (message.edits >= 20) return this.fail(230072, "The message has reached the number of times it can be edited.");
			message.edits += 1;
			message.content = String(data.content);
			return this.ok();
		}
		match = opts.method === "DELETE" ? /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(opts.url) : null;
		if (match) {
			this.recall(match[1]);
			return this.ok();
		}
		if (opts.method === "POST" && opts.url === "/open-apis/cardkit/v1/cards") {
			const id = `card_${++this.seq}`;
			this.cards.set(id, { elements: new Map(), sequence: 0 });
			return this.ok({ card_id: id });
		}
		match = opts.method === "PUT" ? /^\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/elements\/([^/]+)\/content$/.exec(opts.url) : null;
		if (match) {
			const card = this.cards.get(match[1]);
			if (!card) return this.fail(300301, "card not found");
			const sequence = Number(data.sequence);
			if (!(sequence > card.sequence)) return this.fail(300317, "sequence must be increasing");
			card.sequence = sequence;
			card.elements.set(match[2], String(data.content));
			return this.ok();
		}
		match = opts.method === "PATCH" ? /^\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/settings$/.exec(opts.url) : null;
		if (match) {
			const card = this.cards.get(match[1]);
			if (!card) return this.fail(300301, "card not found");
			const sequence = Number(data.sequence);
			if (!(sequence > card.sequence)) return this.fail(300317, "sequence must be increasing");
			card.sequence = sequence;
			return this.ok();
		}
		return this.fail(404, `fake: unhandled ${opts.method} ${opts.url}`);
	};
}
