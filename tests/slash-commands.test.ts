import assert from "node:assert/strict";
import { test } from "node:test";
import { FEISHU_SLASH_COMMANDS, formatSlashCommandHelp } from "../src/slash-commands.js";

test("斜杠命令帮助完整列出支持的命令和用途", () => {
	const help = formatSlashCommandHelp();
	for (const command of ["/help", "/commands", "/new", "/stop", "/steer <内容>", "/queue <内容>", "/q", "/compact", "/model", "/models", "/thinking", "/sessions", "/name", "/resume", "/workspace", "/feishu status", "/feishu usage", "/feishu doctor", "/feishu export", "/feishu policy", "/feishu always", "/feishu footer"]) {
		assert.match(help, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(help, /普通消息 = 注入当前任务/);
	assert.equal(FEISHU_SLASH_COMMANDS.length, 28, "帮助由命令注册表生成（含 E/F 系列新命令）");
	for (const command of ["/retry", "/undo", "/fork", "/export", "/cron", "/feishu approvals", "/feishu prompt", "/feishu budget", "/clear", "/reset"]) {
		assert.ok(help.includes(command), `帮助应列出 ${command}`);
	}
});

test("命令注册表：注册表解析别名、两段式命令与参数", async () => {
	const { resolveCommand } = await import("../src/commands/registry.js");
	assert.equal(resolveCommand("/clear")?.spec.name, "/new");
	assert.equal(resolveCommand("/RESET force")?.spec.name, "/new");
	assert.deepEqual(resolveCommand("/reset force")?.args, ["force"]);
	assert.equal(resolveCommand("/m flash")?.spec.name, "/model");
	assert.equal(resolveCommand("/feishu status")?.spec.name, "/feishu status");
	assert.equal(resolveCommand("/feishu help")?.spec.name, "/help");
	assert.equal(resolveCommand("/feishu prompt set  你好  世界")?.rest, "set  你好  世界");
	assert.equal(resolveCommand("/skill:review"), undefined, "Pi 的技能不归桥管");
	assert.equal(resolveCommand("hello"), undefined);
	const cron = resolveCommand('/cron add "0 9 * * 1-5" 汇总');
	assert.equal(cron?.rest, 'add "0 9 * * 1-5" 汇总');
});

test("命令注册表：打错的命令给出建议；Pi 自己的命令、技能与短命令不纠错", async () => {
	const { suggestCommand } = await import("../src/commands/registry.js");
	assert.equal(suggestCommand("/modle"), "/model");
	assert.equal(suggestCommand("/sesions"), "/sessions");
	assert.equal(suggestCommand("/feishu stauts"), "/feishu status");
	assert.equal(suggestCommand("/modle", new Set(["/modle"])), undefined, "Pi 模板同名时不纠错");
	assert.equal(suggestCommand("/skill:revew"), undefined);
	assert.equal(suggestCommand("/x"), undefined);
	assert.equal(suggestCommand("/completely-unrelated"), undefined);
});
