/**
 * 重新读取配置（`/feishu config reload`）：能热加载的字段写进运行中的配置，要重启的只列出来不应用。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { reloadConfig, reloadModeOf } from "../src/config/reload.js";
import { buildConversationKey } from "../src/session/conversation-key.js";
import { ADMIN, T, withHarness } from "./features/helpers.js";

function withHome(body: (home: string, write: (config: unknown) => void) => void): void {
	const home = mkdtempSync(join(tmpdir(), "cfg-reload-"));
	try {
		mkdirSync(join(home, "feishu-channel"));
		body(home, (config) => writeFileSync(join(home, "feishu-channel", "config.json"), JSON.stringify(config)));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("重新读取配置：热加载字段原地生效，要重启的字段只列出来，运行时字段保留", () => {
	withHome((home, write) => {
		write({ appId: "cli_a", progress: { mode: "new" }, runIdleTimeoutMs: 60_000 });
		const current = loadConfig(home, {});
		current.implicitAdmins = ["ou_owner"];
		const approval = current.approval;

		write({
			appId: "cli_a", progress: { mode: "off" }, runIdleTimeoutMs: 120_000, groupSessionsPerUser: true,
			approval: { adminSkipApproval: true, plugin: { alwaysApprove: false } },
		});
		const result = reloadConfig(home, current, {});

		assert.deepEqual(result.applied.sort(), ["approval.adminSkipApproval", "groupSessionsPerUser", "progress"]);
		assert.deepEqual(result.restartRequired.sort(), ["approval.plugin", "runIdleTimeoutMs"]);
		assert.equal(current.progress.mode, "off");
		assert.equal(current.groupSessionsPerUser, true);
		assert.equal(current.approval.adminSkipApproval, true);
		assert.equal(current.runIdleTimeoutMs, 60_000, "要重启的字段不写进内存：会话管理器还在用旧值，内存里换了反而对不上");
		assert.equal(current.approval.plugin?.alwaysApprove, true, "同一对象里要重启的子字段保持旧值");
		assert.notEqual(current.approval, approval, "有子字段生效时换成新对象（组件都经 rt.config 取子对象）");
		assert.deepEqual(current.implicitAdmins, ["ou_owner"], "启动时查到的字段不从文件读，保留");
	});
});

test("重新读取配置：文件没变化时什么都不做；清空字段的两种写法视为相同", () => {
	withHome((home, write) => {
		write({ groupRules: { oc_x: {} } });
		const current = loadConfig(home, {});
		// 运行中的命令清空字段时可能留下值为 undefined 的键
		current.groupRules = { oc_x: { prompt: undefined } };
		assert.deepEqual(reloadConfig(home, current, {}), { applied: [], restartRequired: [] });
	});
});

test("重新读取配置：文件有错误时抛出带字段路径的错误，运行中的配置不动", () => {
	withHome((home, write) => {
		write({ progress: { mode: "new" } });
		const current = loadConfig(home, {});
		write({ progress: { mode: "quiet" } });
		assert.throws(() => reloadConfig(home, current, {}), /progress\.mode/);
		assert.equal(current.progress.mode, "new");
	});
});

test("重新读取配置：环境变量仍优先于文件", () => {
	withHome((home, write) => {
		write({ progress: { mode: "new" } });
		const env = { FEISHU_PROGRESS_MODE: "all" };
		const current = loadConfig(home, env);
		write({ progress: { mode: "off" } });
		assert.deepEqual(reloadConfig(home, current, env).applied, [], "环境变量覆盖的字段，改文件不算改动");
		assert.equal(current.progress.mode, "all");
	});
});

test("重新读取配置：改了某个群的会话模式，下一条消息就按新的会话键路由", () => {
	withHome((home, write) => {
		write({ groupSessionsPerUser: false });
		const current = loadConfig(home, {});
		const msg = { chatId: "oc_x", chatType: "group" as const, senderId: "ou_a" };
		assert.equal(buildConversationKey(msg, current), "oc_x");
		write({ groupSessionsPerUser: false, groupRules: { oc_x: { sessionsPerUser: true } } });
		assert.deepEqual(reloadConfig(home, current, {}).applied, ["groupRules"]);
		assert.equal(buildConversationKey(msg, current), "oc_x:u:ou_a");
	});
});

test("重新读取配置：字段归类覆盖嵌套字段和按 id 索引的表", () => {
	assert.equal(reloadModeOf(["approval", "commandPolicy", "enabled"]), "live");
	assert.equal(reloadModeOf(["groupRules", "<id>", "tools"]), "live");
	assert.equal(reloadModeOf(["onboarding", "accessRequest"]), "restart");
	assert.equal(reloadModeOf(["implicitAdmins"]), "runtime");
	assert.throws(() => reloadModeOf(["noSuchField"]), /没有归类/);
});

const OTHER = "ou_other";

test("重新读取配置·命令：改了 config.json 后 reload，准入立即按新名单判定", T, async () => {
	await withHarness({ allowUsers: [] }, async (h) => {
		const file = join(h.home, "feishu-channel", "config.json");
		await h.message({ chatId: "oc_dm_other", sender: OTHER, text: "/feishu footer", chatType: "p2p" });
		await h.message({ chatId: "oc_dm_admin", sender: ADMIN, text: "/feishu config reload", chatType: "p2p" });
		await h.waitForMessage("oc_dm_admin", /config\.json 与运行中的配置一致/);
		assert.ok(h.hasLog("feishu.pipeline.drop"), "名单外的人私聊先被拒绝");

		writeFileSync(file, JSON.stringify({ ...h.config(), allowUsers: [OTHER], runIdleTimeoutMs: 5_000 }));
		await h.message({ chatId: "oc_dm_admin", sender: ADMIN, text: "/feishu config reload", chatType: "p2p" });
		await h.waitForMessage("oc_dm_admin", /已生效（1 项）：allowUsers[\s\S]*要重启才生效（1 项，未应用）：runIdleTimeoutMs/);
		assert.ok(h.hasLog("feishu.config.reloaded"));

		await h.message({ chatId: "oc_dm_other", sender: OTHER, text: "/feishu footer", chatType: "p2p" });
		await h.waitForMessage("oc_dm_other", /本会话页脚/);
	});
});

test("重新读取配置·命令：非管理员不能用；文件写坏了不应用并给出字段", T, async () => {
	await withHarness({ allowUsers: [OTHER] }, async (h) => {
		await h.message({ chatId: "oc_dm_other", sender: OTHER, text: "/feishu config reload", chatType: "p2p" });
		await h.waitForMessage("oc_dm_other", /仅管理员或应用归属人可重新读取配置/);

		writeFileSync(join(h.home, "feishu-channel", "config.json"), JSON.stringify({ ...h.config(), progress: { mode: "quiet" } }));
		await h.message({ chatId: "oc_dm_admin", sender: ADMIN, text: "/feishu config reload", chatType: "p2p" });
		await h.waitForMessage("oc_dm_admin", /config\.json 有错误，没有应用任何改动[\s\S]*progress\.mode/);
		assert.ok(h.hasLog("feishu.config.reload_failed"));
	});
});
