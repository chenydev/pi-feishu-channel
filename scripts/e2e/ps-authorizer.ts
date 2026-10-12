/**
 * pi-permission-system 授权链环节的隔离端到端测试。
 *
 * 用真实的 pi 进程和真实的 pi-permission-system，在临时目录里触发一次「询问」，验证本扩展的环节
 * （`PsAuthorizer`，approval/ps-authorizer.ts）能在 PS 就绪时注册上、收到询问、按「管理员的选择」放行或拒绝。
 * 只有「管理员点卡片」这一步是模拟的。不需要飞书凭据，也不需要容器；需要一个能调用工具的模型。
 *
 * 用法（在仓库根目录）：
 *
 *   npx tsx scripts/e2e/ps-authorizer.ts [approve|deny|nochain] [--keep]
 *
 * - `approve`（默认）：PS 配置的 authorizerChain 写上 feishu-channel，模拟管理员点「仅本次」→ 期望弹一次卡，命令执行；
 * - `deny`：同上，模拟管理员点「拒绝」→ 期望弹一次卡，命令不执行；
 * - `nochain`：authorizerChain 不写 → 期望不弹卡，命令被 PS 拒绝（对照组）；
 * - `--keep`：保留临时目录，便于查看 PS 的审查日志与环节收到的询问（`cards.jsonl`）。
 *
 * 环境变量：
 * - `PI_BIN`：pi 可执行文件，默认从 PATH 里找（会跳过 node_modules/.bin，避免用到依赖里的旧版本 pi）；
 * - `PI_HOME`：你平时的 pi 配置目录（默认 `~/.pi/agent`），从这里链接 `auth.json` 与 `models.json` 以便调用模型；
 * - `PS_PACKAGE`：pi-permission-system 包目录，默认 `$PI_HOME/npm/node_modules/@gotgenes/pi-permission-system`；
 * - `E2E_PROVIDER` / `E2E_MODEL`：使用的模型（不设时沿用 `$PI_HOME/settings.json` 的默认模型）。
 *
 * 判据是命令的副作用：命令把一个随机串写进工作目录里的文件，脚本检查文件内容。
 * 不能只看 pi 的输出 —— `echo` 的输出是可以猜到的，模型没执行命令也可能直接答出来；
 * 也不能看 pi 的退出码 —— 命令被拒绝时 pi 同样正常退出。为防止模型改用写文件工具绕过，
 * 测试配置里 write / edit 工具是禁用的。通过时退出码 0，否则 1。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "approve" | "deny" | "nochain";

const args = process.argv.slice(2);
const mode = (args.find((a) => ["approve", "deny", "nochain"].includes(a)) ?? "approve") as Mode;
const keep = args.includes("--keep");

const TOKEN = `ps-link-e2e-${randomBytes(6).toString("hex")}`;
const OUTPUT_FILE = "ps-link-e2e.txt";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piHome = process.env.PI_HOME ?? join(homedir(), ".pi", "agent");
const psPackage = process.env.PS_PACKAGE ?? join(piHome, "npm", "node_modules", "@gotgenes", "pi-permission-system");

const log = (...parts: unknown[]) => console.log(`[e2e:${mode}]`, ...parts);

function fail(message: string): never {
	console.error(`[e2e:${mode}] ${message}`);
	process.exit(2);
}

/** 去掉 node_modules/.bin：`npx tsx` 会把它放到 PATH 最前，而依赖里可能带着另一个版本的 pi。 */
function cleanPath(): string {
	return (process.env.PATH ?? "").split(delimiter).filter((dir) => !dir.includes(`node_modules${"/"}.bin`)).join(delimiter);
}

function findPi(path: string): string {
	if (process.env.PI_BIN) return process.env.PI_BIN;
	for (const dir of path.split(delimiter)) {
		const candidate = join(dir, "pi");
		if (dir && existsSync(candidate)) return candidate;
	}
	return fail("找不到 pi：请把 pi 加到 PATH，或用 PI_BIN 指定");
}

function defaultModel(): { defaultProvider?: string; defaultModel?: string } {
	if (process.env.E2E_PROVIDER || process.env.E2E_MODEL) {
		return { defaultProvider: process.env.E2E_PROVIDER, defaultModel: process.env.E2E_MODEL };
	}
	try {
		const settings = JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
		return { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel };
	} catch {
		return {};
	}
}

/** 临时的 pi 配置目录：只装 pi-permission-system，给 `echo` 配一条「询问」规则。 */
function prepareAgentDir(root: string): string {
	if (!existsSync(join(psPackage, "package.json"))) fail(`找不到 pi-permission-system：${psPackage}（用 PS_PACKAGE 指定包目录）`);
	const version = (JSON.parse(readFileSync(join(psPackage, "package.json"), "utf8")) as { version?: string }).version;
	log("pi-permission-system", version, psPackage);

	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), { recursive: true });
	for (const file of ["auth.json", "models.json"]) {
		if (existsSync(join(piHome, file))) symlinkSync(join(piHome, file), join(agentDir, file));
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: [psPackage],
		...defaultModel(),
		defaultThinkingLevel: "minimal",
		defaultProjectTrust: "always",
	}, null, 2));
	writeFileSync(join(agentDir, "extensions", "pi-permission-system", "config.json"), JSON.stringify({
		permissionReviewLog: true,
		yoloMode: false,
		...(mode === "nochain" ? {} : { authorizerChain: ["feishu-channel"] }),
		permission: { "*": "allow", write: "deny", edit: "deny", bash: { "*": "allow", "echo *": "ask" } },
	}, null, 2));
	return agentDir;
}

/**
 * 测试用的 pi 扩展：挂上真实的 PsAuthorizer，路由固定为一个飞书会话，「管理员」按模式作答。
 * 每次收到询问往 cards.jsonl 写一行，环节的日志写进 link.log。
 */
function writeTestExtension(root: string): string {
	const file = join(root, "link-extension.ts");
	const answer = mode === "deny" ? { verdict: "denied", choice: "deny" } : { verdict: "approved", choice: "once" };
	writeFileSync(file, `
import { appendFileSync } from "node:fs";
import { PsAuthorizer } from ${JSON.stringify(join(REPO, "src", "approval", "ps-authorizer.ts"))};

const root = ${JSON.stringify(root)};
export default function (pi) {
	const authorizer = new PsAuthorizer({
		routeForSessionId: () => ({ conversationKey: "oc_e2e", chatId: "oc_e2e", sourceMessageId: "om_e2e", runId: "run-e2e" }),
		approvalMode: () => "pi-permission-system",
		adminSkip: () => false,
		alwaysApproved: () => undefined,
		allowedOperatorIds: () => ["ou_e2e_admin"],
		requestDecision: async (input) => {
			appendFileSync(root + "/cards.jsonl", JSON.stringify(input) + "\\n");
			await new Promise((resolve) => setTimeout(resolve, 500));
			return { ...${JSON.stringify(answer)}, operatorId: "ou_e2e_admin" };
		},
		log: (level, msg, meta) => appendFileSync(root + "/link.log", level + " " + msg + " " + JSON.stringify(meta ?? {}) + "\\n"),
	});
	authorizer.attach(pi);
}
`);
	return file;
}

async function main(): Promise<boolean> {
	const root = mkdtempSync(join(tmpdir(), "ps-link-e2e-"));
	const agentDir = prepareAgentDir(root);
	const extension = writeTestExtension(root);
	const workDir = join(root, "work");
	mkdirSync(workDir);

	const path = cleanPath();
	const pi = findPi(path);
	const prompt = `用 bash 工具执行 \`echo ${TOKEN} > ${OUTPUT_FILE}\`，完成后回复「完成」。如果命令没能执行，照实说明原因。`;
	log("启动", pi);
	const child = spawn(pi, ["-e", extension, "-p", prompt], {
		cwd: workDir,
		env: { ...process.env, PATH: path, PI_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	const startedAt = Date.now();
	const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));

	const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
	const cards = read(join(root, "cards.jsonl")).split("\n").filter(Boolean);
	const outputPath = join(workDir, OUTPUT_FILE);
	const executed = existsSync(outputPath) && readFileSync(outputPath, "utf8").trim() === TOKEN;
	log("pi 退出码", code, "耗时", `${Date.now() - startedAt}ms`);
	log("pi 输出：", stdout.trim() || "（空）");
	if (stderr.trim()) log("pi 错误输出（末尾）：", stderr.trim().slice(-2000));
	log("环节日志：", read(join(root, "link.log")) || "（空）");
	for (const card of cards) {
		const input = JSON.parse(card) as { toolName?: string; paramsText?: string; reason?: string; choices?: string[] };
		log("审批卡：", JSON.stringify({ toolName: input.toolName, paramsText: input.paramsText, reason: input.reason, choices: input.choices }));
	}
	log("命令执行了", executed, "审批卡数量", cards.length);

	const expected = mode === "approve" ? { executed: true, cards: 1 } : mode === "deny" ? { executed: false, cards: 1 } : { executed: false, cards: 0 };
	const passed = executed === expected.executed && cards.length === expected.cards;
	log(passed ? "通过" : "失败", `（期望：${expected.cards} 张卡，命令${expected.executed ? "执行" : "不执行"}）`);

	if (keep) log("临时目录已保留：", root);
	else rmSync(root, { recursive: true, force: true });
	return passed;
}

process.exit((await main()) ? 0 : 1);
