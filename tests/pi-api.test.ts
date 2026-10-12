/**
 * 本地的 pi 扩展 API 声明（src/pi-types.ts）必须和真实的 pi 对得上。
 *
 * 曾经的问题：本地声明里有 `getAgentDir` / `ui`，测试桩也照着写，测试全绿；真实的 pi 上没有，
 * 没设 `FEISHU_CHANNEL_HOME` 时 `session_start` 抛异常，桥静默不启动。
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "../src/pi-types.js";
import { loadPiAgentDir } from "../src/runtime/agent-dir.js";

/** 编译期核对：本地声明的每个成员都真实存在于 pi 的 ExtensionAPI 上（否则 tsc 报错）。 */
export type LocalMembersExistOnPi = Pick<PiExtensionAPI, keyof ExtensionAPI>;

test("pi agent 目录：优先用包导出的 getAgentDir", async () => {
	assert.equal(await loadPiAgentDir(async () => ({ getAgentDir: () => "/from/sdk" }), {}), "/from/sdk");
});

test("pi agent 目录：包导入失败时按 PI_CODING_AGENT_DIR 推算，支持 ~", async () => {
	const fail = async () => { throw new Error("not found"); };
	assert.equal(await loadPiAgentDir(fail, { PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
	assert.equal(await loadPiAgentDir(fail, { PI_CODING_AGENT_DIR: "~/agent" }), join(homedir(), "agent"));
});

test("pi agent 目录：什么都没有时是 ~/.pi/agent", async () => {
	assert.equal(await loadPiAgentDir(async () => ({}), {}), join(homedir(), ".pi", "agent"));
});

test("pi agent 目录：真实的包可以导入并给出目录", async () => {
	assert.ok((await loadPiAgentDir()).length > 0);
});
