import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { type FileConfig, unknownConfigFields, validateFileConfig } from "../src/config/schema.js";
import type { BridgeConfig } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

// 类型层面：schema 推导的字段集合必须与 BridgeConfig 完全一致（少一个多一个都编译不过）
type MissingInSchema = Exclude<keyof BridgeConfig, keyof FileConfig>;
type ExtraInSchema = Exclude<keyof FileConfig, keyof BridgeConfig>;
const noMissing: [MissingInSchema] extends [never] ? true : MissingInSchema = true;
const noExtra: [ExtraInSchema] extends [never] ? true : ExtraInSchema = true;

function loadFrom(file: string): unknown {
	const home = mkdtempSync(join(tmpdir(), "cfg-schema-"));
	try {
		mkdirSync(join(home, "feishu-channel"));
		copyFileSync(file, join(home, "feishu-channel", "config.json"));
		return JSON.parse(JSON.stringify(loadConfig(home, { TZ: "UTC" })));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function loadInline(value: unknown): () => unknown {
	return () => {
		const home = mkdtempSync(join(tmpdir(), "cfg-schema-"));
		try {
			mkdirSync(join(home, "feishu-channel"));
			writeFileSync(join(home, "feishu-channel", "config.json"), JSON.stringify(value));
			return loadConfig(home, {});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	};
}

test("配置 schema：与 BridgeConfig 字段一一对应", () => {
	assert.equal(noMissing, true);
	assert.equal(noExtra, true);
});

test("配置 schema：示例配置与全字段样例的加载结果与快照一致", () => {
	for (const [src, expected] of [
		["config.example.json", "tests/fixtures/config-example.expected.json"],
		["tests/fixtures/config-full.json", "tests/fixtures/config-full.expected.json"],
	]) {
		assert.deepEqual(loadFrom(src), JSON.parse(readFileSync(expected, "utf8")), src);
	}
});

test("配置 schema：全字段样例没有未知字段，默认配置本身也能通过校验", () => {
	assert.deepEqual(unknownConfigFields(JSON.parse(readFileSync("tests/fixtures/config-full.json", "utf8"))), []);
	assert.doesNotThrow(() => validateFileConfig(DEFAULT_CONFIG));
});

test("配置 schema：错误信息带完整字段路径，多个错误一次列出", () => {
	assert.throws(loadInline({ groupRules: { oc_1: { policy: "everyone" } } }), /config\.groupRules\.oc_1\.policy：群策略「everyone」无效（可选 open\/mention\/disabled\/allowlist\/blacklist\/admin_only）/);
	assert.throws(loadInline({ approval: { timeoutMs: -1 } }), /config\.approval\.timeoutMs：不能是负数/);
	assert.throws(loadInline({ allowChats: "oc_1" }), /config\.allowChats：必须是字符串数组/);
	assert.throws(loadInline({ allowUsers: [1] }), /config\.allowUsers\.0：必须是字符串/);
	assert.throws(loadInline({ debug: "true", batch: { media: 1 } }), /config\.batch\.media：必须是 true\/false；config\.debug：必须是 true\/false/);
});

test("配置 schema：注释键与未知字段不报错（未知字段交给 /feishu doctor 列出）", () => {
	assert.doesNotThrow(loadInline({ _comment: "x", $schema: "y", progress: { _note: 1, maxline: 3 }, allowchats: [] }));
});

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
