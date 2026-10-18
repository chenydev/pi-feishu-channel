/**
 * 会话表：存取 + 自我修正的 sessionId 索引。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionTable } from "../src/session/session-table.js";

type Sess = { conversationKey: string; chatId: string; sessionId?: string };

test("会话表：按 key 存取删除，size/has/迭代与 Map 一致", () => {
	const table = new SessionTable<Sess>();
	table.set("a", { conversationKey: "a", chatId: "oc" });
	table.set("b", { conversationKey: "b", chatId: "oc2" });
	assert.equal(table.size, 2);
	assert.equal(table.has("a"), true);
	assert.deepEqual([...table].map(([key]) => key), ["a", "b"]);
	assert.equal(table.delete("a"), true);
	assert.equal(table.get("a"), undefined);
});

test("会话表：sessionId 索引会自我修正（会话重建/回收后不失配）", () => {
	const table = new SessionTable<Sess>();
	table.set("a", { conversationKey: "a", chatId: "oc", sessionId: "sid-1" });
	assert.equal(table.byId("sid-1")?.conversationKey, "a");

	// 会话被重建：同名 key 换了 sessionId，旧 id 必须查不到
	table.set("a", { conversationKey: "a", chatId: "oc", sessionId: "sid-2" });
	assert.equal(table.byId("sid-1"), undefined, "旧 sessionId 不能命中新会话");
	assert.equal(table.byId("sid-2")?.conversationKey, "a");

	// 空 id 直接给 undefined（工具事件里缺 sessionId 很常见）
	assert.equal(table.byId(""), undefined);
});
