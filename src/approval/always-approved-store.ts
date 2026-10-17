/**
 * 「始终批准」规则表（pi-permission-system 模式）。
 *
 * 背景：PS 授权链上的环节只能放行这一次（PS 不替环节记会话级或永久授权），
 * 所以审批卡上的「始终批准」由桥自己记一份。
 *
 * 粒度取舍：按 **PS 的规则名**（请求里的 `matchedPattern`）记，而不是按命令模式。
 * 理由：规则名是 PS 自己给出的判定依据（审批卡的理由行显示的就是它），
 * 与 PS 的策略语义天然一致；桥不需要自己发明一套模式语言，也就不会和上游跑偏。
 * 代价是粒度偏粗（批准 `echo PS-TEST-*` 会放行所有命中该规则的动作），
 * 所以撤销入口必须存在（见 /feishu always revoke）与审计。
 */
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../runtime/atomic-file.js";

export interface AlwaysApprovedRule {
	/** PS 的规则名（请求 facts.matchedPattern）。 */
	pattern: string;
	/** 批准人 open_id（管理员），审计用。 */
	approvedBy?: string;
	approvedAt: number;
	/** 首次批准时所在的飞书会话（排障用，不参与匹配）。 */
	conversationKey?: string;
}

interface StoreFile {
	version: number;
	rules: AlwaysApprovedRule[];
}

const STORE_VERSION = 1;

/**
 * 纯通配的规则名（PS 配置里的 `"*"`）不能进「始终批准」表。
 *
 * 它匹配的是「任何值」：落盘后**任何会话、任何工具**命中该规则都会被直接放行，
 * 而卡片上只显示「命中规则：*」—— 管理员点一次「始终批准」等于把整个审批关掉，
 * 且重启后仍然生效。这类规则退化为本会话批准（见 `ps-authorizer.ts`）。
 */
export function isWildcardPattern(pattern: string): boolean {
	return /^\*+$/.test(pattern.trim());
}

export class AlwaysApprovedStore {
	private readonly file: string;
	private rules = new Map<string, AlwaysApprovedRule>();
	private readonly now: () => number;

	constructor(options: { file: string; now?: () => number }) {
		this.file = options.file;
		this.now = options.now ?? Date.now;
		this.load();
	}

	private load(): void {
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
			for (const rule of raw?.rules ?? []) {
				if (typeof rule?.pattern === "string" && rule.pattern) {
					// 旧版本可能把通配规则名落了盘（那时不拦）：不再受它影响，下次落盘时顺手清掉
					if (isWildcardPattern(rule.pattern)) continue;
					this.rules.set(rule.pattern, {
						pattern: rule.pattern,
						approvedBy: typeof rule.approvedBy === "string" ? rule.approvedBy : undefined,
						approvedAt: typeof rule.approvedAt === "number" ? rule.approvedAt : this.now(),
						conversationKey: typeof rule.conversationKey === "string" ? rule.conversationKey : undefined,
					});
				}
			}
		} catch {
			// 文件不存在/损坏都当作空表：规则表丢了只会让用户重新点一次，
			// 不该因为一份辅助文件把桥启动搞挂。
			this.rules.clear();
		}
	}

	private persist(): void {
		const payload: StoreFile = { version: STORE_VERSION, rules: [...this.rules.values()] };
		atomicWriteJson(this.file, payload);
	}

	/** 规则是否已被「始终批准」。pattern 为空或纯通配时一律返回 false（没有依据就不自动放行）。 */
	has(pattern: string | null | undefined): boolean {
		if (!pattern || isWildcardPattern(pattern)) return false;
		return this.rules.has(pattern);
	}

	/** 记录一条「始终批准」。重复批准同一条规则只更新元信息。通配规则名会被拒绝（会放行全部同类请求）。 */
	add(rule: { pattern: string; approvedBy?: string; conversationKey?: string }): AlwaysApprovedRule {
		if (isWildcardPattern(rule.pattern)) throw new Error(`「始终批准」不接受通配规则名：${rule.pattern}`);
		const record: AlwaysApprovedRule = {
			pattern: rule.pattern,
			approvedBy: rule.approvedBy,
			approvedAt: this.now(),
			conversationKey: rule.conversationKey,
		};
		this.rules.set(rule.pattern, record);
		this.persist();
		return record;
	}

	/** 撤销一条规则；返回是否真的删掉了。 */
	remove(pattern: string): boolean {
		const existed = this.rules.delete(pattern);
		if (existed) this.persist();
		return existed;
	}

	list(): AlwaysApprovedRule[] {
		return [...this.rules.values()].sort((a, b) => a.approvedAt - b.approvedAt);
	}

	get size(): number {
		return this.rules.size;
	}
}
