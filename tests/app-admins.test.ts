/**
 * 应用归属人 / 应用管理员的识别（runtime/app-admins.ts）：协作者里只有 administrator 算管理员。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeishuTransport } from "../src/inbound/transport.js";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import { loadAppAdmins } from "../src/runtime/app-admins.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function setup(responses: Record<string, unknown | Error>) {
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, appId: "cli_test" };
	rt.transport = {
		rawRequest: async ({ url }: { url: string }) => {
			const key = url.endsWith("/collaborators") ? "collaborators" : "app";
			const value = responses[key];
			if (value instanceof Error) throw value;
			return value;
		},
	} as unknown as FeishuTransport;
	const logs: Array<{ event: string; meta: unknown }> = [];
	const push = (event: string, meta?: unknown) => { logs.push({ event, meta }); };
	return { rt, logs, log: { debug: push, info: push, warn: push, error: push } };
}

const APP = { data: { app: { owner: { owner_id: "ou_owner", type: 2 } } } };

test("应用管理员：协作者里只认 administrator，开发者、运营和角色不明的都不算", async () => {
	const { rt, logs, log } = setup({
		app: APP,
		collaborators: { data: { collaborators: [
			{ type: "administrator", user_id: "ou_owner" },
			{ type: "administrator", user_id: "ou_admin" },
			{ type: "developer", user_id: "ou_dev" },
			{ type: "operator", user_id: "ou_ops" },
			{ user_id: "ou_unknown" },
		] } },
	});
	await loadAppAdmins(rt, log);
	assert.equal(rt.config.appOwnerId, "ou_owner");
	assert.deepEqual(rt.config.appAdminIds, ["ou_admin"], "归属人不重复计入应用管理员");
	assert.deepEqual(rt.config.implicitAdmins, ["ou_owner", "ou_admin"]);
	const hydrated = logs.find((l) => l.event === "feishu.config.app_owner_hydrated")?.meta as Record<string, unknown>;
	assert.deepEqual(hydrated.excludedCollaborators, { developer: 1, operator: 1, unknown: 1 });
	assert.ok(logs.some((l) => l.event === "feishu.config.app_collaborator_type_unknown"));
});

test("应用管理员：协作者接口失败时只认归属人", async () => {
	const { rt, logs, log } = setup({ app: APP, collaborators: new Error("99991672 no permission") });
	await loadAppAdmins(rt, log);
	assert.deepEqual(rt.config.implicitAdmins, ["ou_owner"]);
	assert.ok(logs.some((l) => l.event === "feishu.config.app_collaborators_hydrate_failed"));
});

test("应用管理员：应用信息也查不到时没有隐式管理员，只剩 config.admins", async () => {
	const { rt, logs, log } = setup({ app: new Error("no scope"), collaborators: new Error("no scope") });
	await loadAppAdmins(rt, log);
	assert.deepEqual(rt.config.implicitAdmins, []);
	assert.ok(logs.some((l) => l.event === "feishu.config.app_owner_hydrate_failed"));
});
