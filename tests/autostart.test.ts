import assert from "node:assert/strict";
import { test } from "node:test";
import { autoStartBlocker, channelEnabled } from "../src/runtime/autostart.js";

test("自动启动开关：FEISHU_CHANNEL_ENABLED 只认明确的「开」，未设和其他值都是关", () => {
	for (const value of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(channelEnabled({ FEISHU_CHANNEL_ENABLED: value }), true, value);
	for (const value of [undefined, "", "0", "false", "off", "enabled"]) assert.equal(channelEnabled({ FEISHU_CHANNEL_ENABLED: value }), false, String(value));
	assert.equal(channelEnabled({ FEISHU_BRIDGE_ENABLED: "1" }), true, "旧前缀仍识别");
});

test("自动启动：开关优先于运行模式；没有 mode 的老版本 pi 只看开关", () => {
	const on = { FEISHU_CHANNEL_ENABLED: "1" };
	assert.equal(autoStartBlocker("rpc", on), undefined);
	assert.equal(autoStartBlocker(undefined, on), undefined);
	assert.equal(autoStartBlocker("tui", on), "mode");
	assert.equal(autoStartBlocker("print", on), "mode");
	assert.equal(autoStartBlocker("json", on), "mode");
	assert.equal(autoStartBlocker("rpc", {}), "disabled");
	assert.equal(autoStartBlocker("tui", {}), "disabled");
});
