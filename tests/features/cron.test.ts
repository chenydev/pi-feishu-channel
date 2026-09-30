/**
 * 可选能力·定时任务（cron.enabled）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, DM, T, USER, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

test("定时任务·关：/cron 只回复未启用，不出现在已启用能力里，也没有定时任务日志", T, async () => {
	await withHarness({}, async (h) => {
		await h.message({ chatId: DM, sender: USER, text: "/cron list" });
		await h.waitForMessage(DM, /定时任务未启用（config\.cron\.enabled）/);
		assert.ok(!enabledIn(h).status.includes("cron"));
		assert.ok(!enabledIn(h).log.includes("cron"));
		assert.ok(!hasLogPrefix(h, "feishu.cron"));
	});
});

test("定时任务·开：管理员能新建任务，列表与 /feishu status 可见；普通用户不能新建", T, async () => {
	await withHarness({ admins: [ADMIN], allowUsers: [USER, ADMIN], cron: { enabled: true } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("cron"));
		assert.ok(enabledIn(h).log.includes("cron"));

		await h.message({ chatId: DM, sender: USER, text: "/cron list" });
		await h.waitForMessage(DM, /本会话没有定时任务/);
		await h.message({ chatId: DM, sender: USER, text: '/cron add "0 9 * * *" 汇总告警' });
		await h.waitForMessage(DM, /仅管理员或应用归属人可管理定时任务/);

		const adminDm = "oc_dm_admin";
		await h.message({ chatId: adminDm, sender: ADMIN, text: '/cron add "0 9 * * *" 汇总告警' });
		await h.waitForMessage(adminDm, /已创建定时任务/);
		assert.ok(h.hasLog("feishu.cron.added"));
		await h.message({ chatId: adminDm, sender: ADMIN, text: "/feishu status" });
		await h.waitForMessage(adminDm, /定时任务: 1 个启用/);
	});
});
