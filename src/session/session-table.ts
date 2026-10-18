/**
 * 会话表：`conversationKey → BridgeSession`，外加一个会自我修正的 `sessionId → 会话` 索引。
 *
 * 从 `ConversationManager` 搬出来（原本表、索引、游标和业务判断混在一个类里）。
 * 这里只有「存取」，不决定什么时候建、什么时候回收 —— 那些仍由管理器负责。
 */
export interface TableSession {
	conversationKey: string;
	chatId: string;
	sessionId?: string;
}

export class SessionTable<S extends TableSession> {
	private readonly byKey = new Map<string, S>();
	private readonly keyById = new Map<string, string>();

	get(key: string): S | undefined {
		return this.byKey.get(key);
	}

	set(key: string, session: S): void {
		this.byKey.set(key, session);
	}

	delete(key: string): boolean {
		return this.byKey.delete(key);
	}

	values(): S[] {
		return [...this.byKey.values()];
	}

	entries(): Array<[string, S]> {
		return [...this.byKey.entries()];
	}

	get size(): number {
		return this.byKey.size;
	}

	keys(): IterableIterator<string> {
		return this.byKey.keys();
	}

	has(key: string): boolean {
		return this.byKey.has(key);
	}

	/** 按插入顺序迭代 `[key, session]`（回收/关闭时要遍历）。 */
	[Symbol.iterator](): IterableIterator<[string, S]> {
		return this.byKey[Symbol.iterator]();
	}

	/**
	 * sessionId → 会话。每个工具事件都要查好几次，不能每次全表线性扫描。
	 * 索引是会自我修正的缓存：命中后校验一致性，失配（会话被重建/回收）时回退扫描并回填，
	 * 因此不必在每个创建/回收点手工维护。
	 */
	byId(sessionId: string): S | undefined {
		if (!sessionId) return undefined;
		const key = this.keyById.get(sessionId);
		const cached = key ? this.byKey.get(key) : undefined;
		if (cached?.sessionId === sessionId) return cached;
		const found = this.values().find((candidate) => candidate.sessionId === sessionId);
		if (found) this.keyById.set(sessionId, found.conversationKey);
		else this.keyById.delete(sessionId);
		return found;
	}

	/** 索引里登记了几条（诊断用：正常不超过会话数）。 */
	get indexedIds(): number {
		return this.keyById.size;
	}
}
