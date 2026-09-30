/**
 * 从配置 schema 生成 docs/configuration.md。
 *
 *   npm run docs:config            # 重新生成
 *   npm run docs:config -- --check # 只检查文档是否与 schema 一致（不一致时退出码 1）
 *
 * 字段、类型、取值范围和说明来自 `src/config/schema.ts`；默认值是空配置经 `loadConfig` 加载后的实际值，
 * 不在其中的（由各模块在用到时兜底）取字段说明里的 `default`。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { type FieldMeta, fileConfigSchema } from "../src/config/schema.js";

export const REFERENCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "configuration.md");

interface Row { path: string; type: string; defaultValue: string; env: string; description: string }

function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) current = current.unwrap() as z.ZodType;
	return current;
}

export function metaOf(schema: z.ZodType): FieldMeta | undefined {
	return (schema.meta() ?? unwrap(schema).meta()) as FieldMeta | undefined;
}

function typeOf(schema: z.ZodType): string {
	const inner = unwrap(schema);
	if (inner instanceof z.ZodString) return "string";
	if (inner instanceof z.ZodNumber) return "number";
	if (inner instanceof z.ZodBoolean) return "boolean";
	if (inner instanceof z.ZodEnum) return inner.options.map((value) => `"${String(value)}"`).join(" \\| ");
	if (inner instanceof z.ZodArray) return `${typeOf(inner.element as z.ZodType)}[]`;
	if (inner instanceof z.ZodUnion) return (inner.options as z.ZodType[]).map(typeOf).join(" \\| ");
	if (inner instanceof z.ZodRecord) {
		const value = unwrap(inner.valueType as z.ZodType);
		return `{ [id]: ${value instanceof z.ZodObject ? "对象" : typeOf(value)} }`;
	}
	if (inner instanceof z.ZodObject) return "对象";
	throw new Error(`config-reference：不认识的 schema 类型 ${inner.constructor.name}`);
}

function valueAt(config: unknown, path: string[]): unknown {
	let current = config;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function humanDuration(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
	if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
	if (ms % 1_000 === 0) return `${ms / 1_000} 秒`;
	return "";
}

function formatDefault(path: string[], effective: unknown, meta: FieldMeta | undefined): string {
	const value = effective !== undefined ? effective : meta?.default !== undefined ? JSON.parse(meta.default) as unknown : undefined;
	if (value === undefined) return "—";
	const text = `\`${JSON.stringify(value)}\``;
	if (typeof value === "number" && value >= 1_000 && path[path.length - 1].endsWith("Ms")) {
		const human = humanDuration(value);
		return human ? `${text}（${human}）` : text;
	}
	return text;
}

function formatEnv(schema: z.ZodType, meta: FieldMeta | undefined): string {
	if (!meta?.env) return "";
	const inner = unwrap(schema);
	if (inner instanceof z.ZodArray) return `\`${meta.env}\`（逗号分隔）`;
	if (inner instanceof z.ZodRecord) return `\`${meta.env}\`（JSON）`;
	return `\`${meta.env}\``;
}

function rowsOf(shape: Record<string, z.ZodType>, prefix: string[], defaults: unknown, recurse: boolean): Row[] {
	const rows: Row[] = [];
	for (const [key, schema] of Object.entries(shape)) {
		const path = [...prefix, key];
		const meta = metaOf(schema);
		if (!meta?.description) throw new Error(`config-reference：字段 ${path.join(".")} 缺少说明`);
		const inner = unwrap(schema);
		if (recurse && inner instanceof z.ZodObject) {
			rows.push(...rowsOf(inner.shape as Record<string, z.ZodType>, path, defaults, true));
			continue;
		}
		rows.push({
			path: path.join("."),
			type: typeOf(schema),
			defaultValue: formatDefault(path, valueAt(defaults, path), meta),
			env: formatEnv(schema, meta),
			description: meta.description,
		});
	}
	return rows;
}

function table(rows: Row[]): string {
	const lines = ["| 字段 | 类型 | 默认 | 环境变量 | 说明 |", "|---|---|---|---|---|"];
	for (const row of rows) lines.push(`| \`${row.path}\` | ${row.type} | ${row.defaultValue} | ${row.env} | ${row.description.replaceAll("|", "\\|")} |`);
	return lines.join("\n");
}

/** 空配置（无文件、无环境变量）加载后的实际配置。 */
export function effectiveDefaults(): unknown {
	const home = mkdtempSync(join(tmpdir(), "config-reference-"));
	try {
		return JSON.parse(JSON.stringify(loadConfig(home, {})));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

export function renderConfigReference(): string {
	const defaults = effectiveDefaults();
	const shape = fileConfigSchema.shape as Record<string, z.ZodType>;
	const topLevel: Row[] = [];
	const runtime: Row[] = [];
	const sections: string[] = [];
	for (const [key, schema] of Object.entries(shape)) {
		const meta = metaOf(schema);
		const inner = unwrap(schema);
		if (meta?.runtime) {
			runtime.push(...rowsOf({ [key]: schema }, [], defaults, false));
		} else if (inner instanceof z.ZodObject) {
			sections.push(`## \`${key}\`：${meta?.description}\n\n${table(rowsOf(inner.shape as Record<string, z.ZodType>, [key], defaults, true))}`);
		} else {
			topLevel.push(...rowsOf({ [key]: schema }, [], defaults, false));
			const value = inner instanceof z.ZodRecord ? unwrap(inner.valueType as z.ZodType) : undefined;
			if (value instanceof z.ZodObject) {
				sections.unshift(`## \`${key}.<id>\`：${key} 里每一项的字段\n\n不设的字段沿用对应的全局设置。\n\n${table(rowsOf(value.shape as Record<string, z.ZodType>, [key, "<id>"], defaults, true))}`);
			}
		}
	}
	return `<!-- 本文件由 npm run docs:config 从 src/config/schema.ts 生成，不要手工修改。 -->

# 配置参考

配置文件是 \`<home>/feishu-channel/config.json\`。\`<home>\` 是环境变量 \`FEISHU_CHANNEL_HOME\` 指定的目录，没有设置时是 pi 的 agent 目录（通常是 \`~/.pi/agent\`）。
完整示例见仓库根目录的 [config.example.json](../config.example.json)。

- **全部字段都是可选的**，没写的取下表的默认值。默认值为「—」的字段表示不设置（对应的功能按说明里的方式处理）。
- **环境变量优先于配置文件**：设置了表中的环境变量时，以环境变量为准（注意 shell 里残留的同名变量会静默覆盖配置文件）。
- **启动时校验**：类型或取值不对时拒绝启动，并一次列出全部问题，例如 \`配置无效：config.progress.mode：进度档位「quiet」无效（可选 off/new/all/verbose）\`。
- **拼错的字段不会报错**，但 \`/feishu doctor\` 的 \`config_fields\` 项会列出来。
- 以 \`_\` 或 \`$\` 开头的键当注释用（如 \`"_comment"\`），不校验。
- 时长字段的单位都是毫秒。

## 顶层字段

${table(topLevel)}

${sections.join("\n\n")}

## 运行时字段

下面的字段在启动时从开放平台查询得到，不需要写进配置文件（写了会被查询结果覆盖）。

${table(runtime)}
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const next = renderConfigReference();
	if (process.argv.includes("--check")) {
		const current = readFileSync(REFERENCE_FILE, "utf8");
		if (current !== next) {
			console.error("docs/configuration.md 与 schema 不一致，请运行 npm run docs:config");
			process.exit(1);
		}
		console.log("docs/configuration.md 与 schema 一致");
	} else {
		writeFileSync(REFERENCE_FILE, next);
		console.log(`已生成 ${REFERENCE_FILE}`);
	}
}
