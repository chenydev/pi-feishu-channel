import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { effectiveDefaults, metaOf, REFERENCE_FILE, renderConfigReference } from "../scripts/config-reference.ts";
import { fileConfigSchema } from "../src/config/schema.js";

/** 遍历 schema 的全部字段（含按 id 索引的表里每一项的字段）。 */
function* fields(schema: z.ZodType, path: string[] = []): Generator<{ path: string[]; schema: z.ZodType }> {
	let inner = schema;
	while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
	if (path.length > 0) yield { path, schema };
	if (inner instanceof z.ZodObject) {
		for (const [key, child] of Object.entries(inner.shape as Record<string, z.ZodType>)) yield* fields(child, [...path, key]);
	} else if (inner instanceof z.ZodRecord && inner.valueType instanceof z.ZodObject) {
		for (const [key, child] of Object.entries(inner.valueType.shape as Record<string, z.ZodType>)) yield* fields(child, [...path, "<id>", key]);
	}
}

function valueAt(config: unknown, path: string[]): unknown {
	return path.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), config);
}

test("配置参考：docs/configuration.md 与 schema 一致（不一致时运行 npm run docs:config）", () => {
	assert.equal(readFileSync(REFERENCE_FILE, "utf8"), renderConfigReference());
});

test("配置参考：每个字段都有说明", () => {
	const missing = [...fields(fileConfigSchema)].filter((f) => !metaOf(f.schema)?.description).map((f) => f.path.join("."));
	assert.deepEqual(missing, []);
});

test("配置参考：说明里写的默认值与实际加载结果不矛盾", () => {
	const defaults = effectiveDefaults();
	const conflicts = [...fields(fileConfigSchema)].flatMap((f) => {
		const documented = metaOf(f.schema)?.default;
		const actual = valueAt(defaults, f.path);
		if (documented === undefined || actual === undefined) return [];
		return JSON.stringify(JSON.parse(documented)) === JSON.stringify(actual) ? [] : [`${f.path.join(".")}：文档 ${documented}，实际 ${JSON.stringify(actual)}`];
	});
	assert.deepEqual(conflicts, []);
});

test("配置参考：列出的环境变量确实被读取", () => {
	const source = readFileSync("src/config.ts", "utf8");
	const unread = [...fields(fileConfigSchema)].flatMap((f) => {
		const env = metaOf(f.schema)?.env;
		if (!env) return [];
		const channelName = env.startsWith("FEISHU_CHANNEL_") ? `channelEnv(env, "${env.slice("FEISHU_CHANNEL_".length)}")` : undefined;
		return source.includes(env) || (channelName && source.includes(channelName)) ? [] : [env];
	});
	assert.deepEqual(unread, []);
});
