import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, resolvePaths } from "../src/config.js";
import { channelEnv, deprecatedEnvNames, migrateRuntimeDir, prepareRuntimeDir } from "../src/runtime/identity.js";
import type { BridgeLogger } from "../src/runtime/logger.js";

function withHome(fn: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "runtime-identity-"));
	try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function recordingLog(): BridgeLogger & { lines: { level: string; msg: string; meta?: unknown }[] } {
	const lines: { level: string; msg: string; meta?: unknown }[] = [];
	const push = (level: string) => (msg: string, meta?: unknown) => { lines.push({ level, msg, meta }); };
	return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

test("运行时目录：默认路径都在 feishu-channel/ 下", () => {
	const paths = resolvePaths("/h");
	for (const value of Object.values(paths)) assert.ok(value.startsWith("/h/feishu-channel/"), value);
});

test("运行时目录：只有旧目录时改名迁移，原位置留软链接，配置照常加载", () => {
	withHome((home) => {
		mkdirSync(join(home, "feishu-bridge", "sessions"), { recursive: true });
		writeFileSync(join(home, "feishu-bridge", "config.json"), JSON.stringify({ appId: "cli_x", allowChats: ["oc_1"] }));
		writeFileSync(join(home, "feishu-bridge", "sessions", "a.jsonl"), "{}\n");
		const log = recordingLog();

		assert.equal(prepareRuntimeDir(home, {}, log), true);

		assert.deepEqual(log.lines.map((l) => l.msg), ["feishu.config.migrated"]);
		assert.deepEqual(log.lines[0].meta, { from: join(home, "feishu-bridge"), to: join(home, "feishu-channel"), compatLink: true });
		assert.ok(lstatSync(join(home, "feishu-channel")).isDirectory());
		assert.ok(lstatSync(join(home, "feishu-bridge")).isSymbolicLink());
		assert.equal(readlinkSync(join(home, "feishu-bridge")), "feishu-channel", "相对链接：整个目录搬走或换挂载点后仍然有效");
		// 旧绝对路径（会话文件里记录的、外部脚本写死的）仍可读
		assert.equal(readFileSync(join(home, "feishu-bridge", "sessions", "a.jsonl"), "utf8"), "{}\n");
		assert.deepEqual(loadConfig(home, {}).allowChats, ["oc_1"]);

		// 再次启动：旧位置已是软链接，不再迁移、不再告警
		const again = recordingLog();
		assert.equal(prepareRuntimeDir(home, {}, again), true);
		assert.deepEqual(again.lines, []);
	});
});

test("运行时目录：只有新目录或都没有时什么都不做", () => {
	withHome((home) => {
		assert.deepEqual(migrateRuntimeDir(home), { action: "none" });
		mkdirSync(join(home, "feishu-channel"));
		assert.deepEqual(migrateRuntimeDir(home), { action: "none" });
	});
});

test("运行时目录：新旧都有时用新目录，旧目录原样保留并告警", () => {
	withHome((home) => {
		mkdirSync(join(home, "feishu-bridge"));
		mkdirSync(join(home, "feishu-channel"));
		writeFileSync(join(home, "feishu-bridge", "config.json"), JSON.stringify({ allowChats: ["oc_old"] }));
		writeFileSync(join(home, "feishu-channel", "config.json"), JSON.stringify({ allowChats: ["oc_new"] }));
		const log = recordingLog();

		assert.equal(prepareRuntimeDir(home, {}, log), true);

		assert.deepEqual(log.lines.map((l) => [l.level, l.msg]), [["warn", "feishu.config.legacy_dir_ignored"]]);
		assert.ok(lstatSync(join(home, "feishu-bridge")).isDirectory());
		assert.deepEqual(loadConfig(home, {}).allowChats, ["oc_new"]);
	});
});

test("运行时目录：改名失败时记日志并返回 false（不在迁移一半的状态下启动）", { skip: process.getuid?.() === 0 ? "root 不受目录权限限制" : false }, () => {
	withHome((home) => {
		mkdirSync(join(home, "feishu-bridge"));
		chmodSync(home, 0o500);
		const log = recordingLog();
		try {
			assert.equal(prepareRuntimeDir(home, {}, log), false);
		} finally {
			chmodSync(home, 0o700);
		}
		assert.deepEqual(log.lines.map((l) => [l.level, l.msg]), [["error", "feishu.config.migrate_failed"]]);
		assert.ok(lstatSync(join(home, "feishu-bridge")).isDirectory(), "旧目录原样保留");
	});
});

test("环境变量：FEISHU_CHANNEL_* 优先，旧名 FEISHU_BRIDGE_* 仍识别并告警", () => {
	assert.equal(channelEnv({ FEISHU_CHANNEL_HOME: "/new", FEISHU_BRIDGE_HOME: "/old" }, "HOME"), "/new");
	assert.equal(channelEnv({ FEISHU_BRIDGE_HOME: "/old" }, "HOME"), "/old");
	assert.equal(channelEnv({}, "HOME"), undefined);

	const env = { FEISHU_BRIDGE_POLICY_ENGINE: "pi-permission-system", FEISHU_BRIDGE_HOME: "/old", FEISHU_APP_ID: "x" };
	assert.deepEqual(deprecatedEnvNames(env), [
		{ name: "FEISHU_BRIDGE_HOME", replacement: "FEISHU_CHANNEL_HOME" },
		{ name: "FEISHU_BRIDGE_POLICY_ENGINE", replacement: "FEISHU_CHANNEL_POLICY_ENGINE" },
	]);
	withHome((home) => {
		const log = recordingLog();
		prepareRuntimeDir(home, env, log);
		assert.deepEqual(log.lines.map((l) => [l.level, l.msg, (l.meta as { name: string }).name]), [
			["warn", "feishu.config.deprecated_env", "FEISHU_BRIDGE_HOME"],
			["warn", "feishu.config.deprecated_env", "FEISHU_BRIDGE_POLICY_ENGINE"],
		]);
		assert.equal(loadConfig(home, env).approval.policyEngine, "pi-permission-system", "旧名仍然生效");
		assert.equal(loadConfig(home, { ...env, FEISHU_CHANNEL_POLICY_ENGINE: "bridge" }).approval.policyEngine, "bridge", "新名优先");
	});
});
