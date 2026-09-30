/**
 * 卡片回调路由：op 查表分发、token 去重、会话类按钮授权、op 重复登记在启动时报错。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CardOpConflictError, CardRouter } from "../src/interaction/card-router.js";
import type { CardAction } from "../src/inbound/transport.js";

function setup(admins = ["ou_admin"]) {
	const logs: Array<{ level: string; msg: string; meta: unknown }> = [];
	const log = {
		info: (msg: string, meta?: unknown) => logs.push({ level: "info", msg, meta }),
		warn: (msg: string, meta?: unknown) => logs.push({ level: "warn", msg, meta }),
		error: (msg: string, meta?: unknown) => logs.push({ level: "error", msg, meta }),
	};
	const calls: string[] = [];
	const router = new CardRouter({ log, admins: () => admins });
	router.register("model", {
		"model.set": { sessionScoped: true, run: () => { calls.push("model.set"); return { toast: "ok" }; } },
	});
	router.register("command", { command: (_a, value) => { calls.push(`command:${value.command}`); return "done"; } });
	return { router, logs, calls, has: (msg: string) => logs.some((l) => l.msg === msg) };
}

const click = (value: Record<string, unknown>, extra: Partial<CardAction> = {}): CardAction =>
	({ messageId: "om_card", chatId: "oc_g", operatorOpenId: "ou_user", value, ...extra }) as CardAction;

test("卡片路由：按 op 分发到登记的处理函数，并记录 feishu.card.action", async () => {
	const { router, calls, has } = setup();
	assert.equal(await router.handle(click({ op: "command", command: "/help" })), "done");
	assert.deepEqual(calls, ["command:/help"]);
	assert.ok(has("feishu.card.action"));
});

test("卡片路由：未登记的 op 与没有 op 的回调不处理", async () => {
	const { router, calls, has } = setup();
	assert.equal(await router.handle(click({ op: "nope" })), undefined);
	assert.equal(await router.handle(click({})), undefined);
	assert.equal(calls.length, 0);
	assert.ok(has("feishu.card.action"), "没有匹配也要留下回调日志");
});

test("卡片路由：同一个 token 只处理一次", async () => {
	const { router, calls, has } = setup();
	await router.handle(click({ op: "command", command: "/a" }, { token: "t1" }));
	assert.equal(await router.handle(click({ op: "command", command: "/a" }, { token: "t1" })), undefined);
	assert.deepEqual(calls, ["command:/a"]);
	assert.ok(has("feishu.card.duplicate_token"));
});

test("卡片路由：会话类按钮的授权矩阵", async () => {
	const cases: Array<{ name: string; value: Record<string, unknown>; operator: string; chatId?: string; ok: boolean }> = [
		{ name: "发起人本人", value: { conversationKey: "oc_g", owner: "ou_user" }, operator: "ou_user", ok: true },
		{ name: "管理员", value: { conversationKey: "oc_g", owner: "ou_user" }, operator: "ou_admin", ok: true },
		{ name: "其他人", value: { conversationKey: "oc_g", owner: "ou_user" }, operator: "ou_other", ok: false },
		{ name: "按人隔离的群会话", value: { conversationKey: "oc_g:u:ou_user", owner: "ou_user" }, operator: "ou_user", ok: true },
		{ name: "卡片属于别的群（管理员也拒绝）", value: { conversationKey: "oc_x", owner: "ou_user" }, operator: "ou_admin", ok: false },
		{ name: "没有发起人的旧卡片：管理员", value: { conversationKey: "oc_g" }, operator: "ou_admin", ok: true },
		{ name: "没有发起人的旧卡片：普通用户", value: { conversationKey: "oc_g" }, operator: "ou_user", ok: false },
	];
	for (const c of cases) {
		const { router, calls, has } = setup();
		const result = await router.handle(click({ op: "model.set", ...c.value }, { operatorOpenId: c.operator }));
		assert.equal(calls.length === 1, c.ok, c.name);
		if (!c.ok) {
			assert.equal((result as { toast: { type: string } }).toast.type, "warning", c.name);
			assert.ok(has("feishu.card.unauthorized"), c.name);
		}
	}
});

test("卡片路由：两个模块登记同一个 op 时报错并记录 feishu.card.op_conflict", () => {
	const { router, logs } = setup();
	assert.throws(() => router.register("other", { extra: () => 1, command: () => 2 }), (error: unknown) => {
		assert.ok(error instanceof CardOpConflictError);
		assert.equal(error.op, "command");
		assert.deepEqual(error.owners, ["command", "other"]);
		return true;
	});
	const conflict = logs.find((l) => l.msg === "feishu.card.op_conflict");
	assert.deepEqual(conflict?.meta, { op: "command", owners: ["command", "other"] });
	assert.equal(router.ops().extra, undefined, "冲突的这一组一个都不登记");
	assert.deepEqual(router.ops(), { "model.set": "model", command: "command" });
});
