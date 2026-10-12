/**
 * 工作区的运行中管理：`/workspace add|rm|default`（仅管理员），以及 `workspaces.default` 对新会话的作用。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgeConfig } from "../../src/types.js";
import type { Harness } from "../integration/extension-harness.js";
import { ADMIN, T, USER, withHarness } from "./helpers.js";

const ADMIN_DM = "oc_dm_admin";
const USER_DM = "oc_dm_user";

async function command(h: Harness, sender: string, chatId: string, text: string, expect: RegExp): Promise<void> {
	await h.message({ chatId, sender, text });
	await h.waitForMessage(chatId, expect);
}

/** 发一条普通消息让会话建起来，返回它拿到的工作目录。 */
async function cwdOf(h: Harness, sender: string, chatId: string): Promise<string | undefined> {
	await h.message({ chatId, sender, text: "你好" });
	const deadline = Date.now() + 3_000;
	while (!h.sessions.cwds.has(chatId)) {
		if (Date.now() > deadline) throw new Error("会话没有建起来");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return h.sessions.cwds.get(chatId);
}

const workspaces = (h: Harness) => (h.config() as Partial<BridgeConfig>).workspaces;

async function withDirs(body: (dirs: { a: string; b: string }) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "workspace-admin-"));
	const a = join(root, "a");
	const b = join(root, "b");
	mkdirSync(a);
	mkdirSync(b);
	try { await body({ a, b }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("工作区·运行中添加：不用重启就能添加、切换、设为默认；新会话用默认工作区", T, async () => {
	await withDirs(async ({ a, b }) => {
		await withHarness({ allowUsers: [USER, ADMIN] }, async (h) => {
			await command(h, ADMIN, ADMIN_DM, `/workspace add proj ${a}`, /已添加工作区 proj/);
			await command(h, ADMIN, ADMIN_DM, `/workspace add other ${b}`, /已添加工作区 other/);
			assert.deepEqual(workspaces(h)?.aliases, { proj: a, other: b }, "写回配置文件");

			await command(h, ADMIN, ADMIN_DM, "/workspace default proj", /默认工作区：proj/);
			assert.equal(workspaces(h)?.default, "proj");
			assert.equal(await cwdOf(h, USER, USER_DM), realpathSync(a), "没切换过的新会话用默认工作区");

			await h.message({ chatId: USER_DM, sender: USER, text: "/workspace" });
			const info = await h.waitForMessage(USER_DM, /当前工作区：proj[\s\S]*· proj（默认）[\s\S]*· other/);
			assert.ok(!info.content.includes(a), "普通成员看不到目录");
			await command(h, ADMIN, ADMIN_DM, "/workspace", new RegExp(`· proj（默认）：${a}`));
		});
	});
});

test("工作区·删除与清除默认：默认工作区不能直接删；清除默认后可以删", T, async () => {
	await withDirs(async ({ a }) => {
		await withHarness({ allowUsers: [USER, ADMIN], workspaces: { aliases: { proj: a }, default: "proj" } }, async (h) => {
			await command(h, ADMIN, ADMIN_DM, "/workspace rm proj", /proj 是默认工作区/);
			await command(h, ADMIN, ADMIN_DM, "/workspace default reset", /已清除默认工作区/);
			await command(h, ADMIN, ADMIN_DM, "/workspace rm proj", /已删除工作区 proj/);
			assert.deepEqual(workspaces(h), { aliases: {} });
			assert.equal(await cwdOf(h, USER, USER_DM), undefined, "回到进程启动目录");
		});
	});
});

test("工作区·校验与权限：非管理员不能管理；别名、路径不合法时不写配置", T, async () => {
	await withDirs(async ({ a }) => {
		await withHarness({ allowUsers: [USER, ADMIN] }, async (h) => {
			await command(h, USER, USER_DM, `/workspace add proj ${a}`, /仅管理员或应用归属人可管理工作区/);
			await command(h, ADMIN, ADMIN_DM, "/workspace add proj relative/dir", /请给出绝对路径/);
			await command(h, ADMIN, ADMIN_DM, `/workspace add proj ${join(a, "missing")}`, /目录不存在或不可访问/);
			await command(h, ADMIN, ADMIN_DM, `/workspace add a.b ${a}`, /别名只能用/);
			await command(h, ADMIN, ADMIN_DM, `/workspace add default ${a}`, /别名只能用/);
			await command(h, ADMIN, ADMIN_DM, "/workspace default nope", /没有这个工作区：nope/);
			assert.equal(workspaces(h), undefined);
		});
	});
});
