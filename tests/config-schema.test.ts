import assert from "node:assert/strict";
import { test } from "node:test";
import { unknownConfigFields } from "../src/config/schema.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("配置字段表：默认配置的全部字段都可识别", () => {
	assert.deepEqual(unknownConfigFields(DEFAULT_CONFIG), []);
});

test("配置字段表：拼错的字段按路径列出；按 id 索引的表与注释键不误报", () => {
	assert.deepEqual(unknownConfigFields({
		allowchats: [],
		progress: { maxline: 3, mode: "all" },
		groupRules: { oc_1: { prompt: "x", promt: "y" } },
		footerByChat: { oc_1: true },
		userPrompts: { ou_1: "hi" },
		_comment: "注释",
		approval: { forwarding: { enable: true } },
	}), ["allowchats", "progress.maxline", "groupRules.oc_1.promt", "approval.forwarding.enable"]);
});
