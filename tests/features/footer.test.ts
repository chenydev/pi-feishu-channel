/**
 * 回答页脚（footer.enabled，默认关）：`/feishu footer` 的本会话开关、`-g` 全局开关与 reset。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFooterEnabled } from "../../src/config.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../../src/types.js";
import type { Harness } from "../integration/extension-harness.js";
import { ADMIN, T, USER, withHarness } from "./helpers.js";

const DM = "oc_dm_admin";

async function command(h: Harness, sender: string, chatId: string, text: string, expect: RegExp): Promise<void> {
	await h.message({ chatId, sender, text });
	await h.waitForMessage(chatId, expect);
}

/** 按文件里的配置判定某个会话是否显示页脚（重启后的效果）。 */
function enabledAfterRestart(h: Harness, chatId: string): boolean {
	const file = h.config() as Partial<BridgeConfig>;
	return resolveFooterEnabled({ ...DEFAULT_CONFIG, footer: { ...DEFAULT_CONFIG.footer, ...file.footer }, footerByChat: file.footerByChat ?? {} }, chatId).enabled;
}

test("页脚·关（默认）：不配置时不显示，命令里说明跟随全局", T, async () => {
	await withHarness({ allowUsers: [USER, ADMIN] }, async (h) => {
		await command(h, USER, "oc_dm_user", "/feishu footer", /本会话页脚：关（跟随全局）；全局默认：关/);
	});
});

test("页脚·开：本会话开关只影响本会话；-g 改全局；reset 改回跟随全局", T, async () => {
	await withHarness({ allowUsers: [USER, ADMIN] }, async (h) => {
		await command(h, ADMIN, DM, "/feishu footer on", /已开启本会话页脚/);
		assert.equal(enabledAfterRestart(h, DM), true);
		assert.equal(enabledAfterRestart(h, "oc_other"), false, "别的会话仍跟随全局（关）");

		await command(h, ADMIN, DM, "/feishu footer on -g", /已开启全局页脚（立即生效）。有 1 个会话单独设置过/);
		assert.deepEqual((h.config() as Partial<BridgeConfig>).footer, { enabled: true });
		assert.equal(enabledAfterRestart(h, "oc_other"), true);

		await command(h, ADMIN, DM, "/feishu footer off", /已关闭本会话页脚/);
		await command(h, ADMIN, DM, "/feishu footer reset", /本会话页脚改回跟随全局（当前开）/);
		assert.equal((h.config() as Partial<BridgeConfig>).footerByChat?.[DM], undefined);
		assert.equal(enabledAfterRestart(h, DM), true);
	});
});

test("页脚·权限：非管理员能查看不能修改，-g 也不行", T, async () => {
	await withHarness({ allowUsers: [USER, ADMIN] }, async (h) => {
		await command(h, USER, "oc_dm_user", "/feishu footer on", /仅管理员或应用归属人可修改页脚设置/);
		await command(h, USER, "oc_dm_user", "/feishu footer on -g", /仅管理员或应用归属人可修改页脚设置/);
		assert.equal((h.config() as Partial<BridgeConfig>).footer, undefined);
	});
});
