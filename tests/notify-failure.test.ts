import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("通知投递失败要留日志（否则用户只看到「什么也没说」）", async () => {
	const logs: Array<{ msg: string; meta: unknown }> = [];
	const push = (_level: string, msg: string, meta?: unknown) => { logs.push({ msg, meta }); };
	const manager = new ConversationManager({
		config: { ...DEFAULT_CONFIG, admins: ["ou_admin"] },
		sessionDir: "/tmp/feishu-notify-test",
		sender: { send: async () => ({ success: false, error: "230002 bot not in chat" }) } as never,
		sessionBackend: { createSession: async () => { throw new Error("not used"); } } as never,
		log: push,
	});
	// 私有方法：用 any 调用，验的是「失败有日志」这一条约定
	const ok = await (manager as unknown as { notify: (...args: unknown[]) => Promise<boolean> })
		.notify("oc_x", "任务失败", undefined, "k", "oc_x", "error");
	assert.equal(ok, false);
	const failed = logs.find((entry) => entry.msg === "feishu.conv.notify_failed");
	assert.ok(failed, "必须有日志");
	assert.equal((failed.meta as { error: string }).error, "230002 bot not in chat");
});
