/**
 * 可选能力·管理员直接执行命令（directBash.enabled）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, T, USER, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("直接执行命令·关：`!<命令>` 当普通消息交给模型，没有审计日志", T, async () => {
	await withHarness({}, async (h) => {
		await h.message({ chatId: "oc_dm", sender: USER, text: "!ls" });
		const deadline = Date.now() + 3_000;
		while (!h.sessions.prompts.some((p) => p.text.includes("!ls"))) {
			if (Date.now() > deadline) throw new Error("消息没有交给会话");
			await sleep(10);
		}
		assert.ok(!hasLogPrefix(h, "feishu.direct_bash"));
		assert.ok(!enabledIn(h).status.includes("directBash"));
	});
});

test("直接执行命令·开：非管理员被拒；危险命令对管理员也拒绝；每次都有审计日志", T, async () => {
	await withHarness({ allowUsers: [USER, ADMIN], directBash: { enabled: true } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("directBash"));
		await h.message({ chatId: "oc_dm", sender: USER, text: "!ls" });
		await h.waitForMessage("oc_dm", /直接执行命令仅限管理员/);
		await h.message({ chatId: "oc_dm_admin", sender: ADMIN, text: "!rm -rf /" });
		await h.waitForMessage("oc_dm_admin", /已拒绝/);
		const outcomes = h.logs.filter((l) => l.event === "feishu.direct_bash.audit").map((l) => (l.meta as { outcome: string }).outcome);
		assert.deepEqual(outcomes, ["rejected_not_admin", "denied"]);
		assert.equal(h.sessions.prompts.length, 0, "不经过模型");
	});
});
