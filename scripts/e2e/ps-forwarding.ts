/**
 * pi-permission-system 父会话转发的隔离端到端测试。
 *
 * 用真实的 pi 进程和真实的 pi-permission-system 扩展，在临时目录里触发一次「询问」，
 * 验证本扩展的转发应答方（`PsForwardingServer`）能读到请求、弹出审批（这里由脚本模拟管理员点「仅本次」）、
 * 把响应写回，pi 随后真的执行了命令。不需要飞书凭据，也不需要容器；需要一个能调用工具的模型。
 *
 * 用法（在仓库根目录）：
 *
 *   npx tsx scripts/e2e/ps-forwarding.ts [both|convention|none] [--delay 秒] [--keep]
 *
 * - `both`（默认）：同时设置 PI_SUBAGENT_PARENT_SESSION 与 PI_AGENT_ROUTER_PARENT_SESSION_ID（本扩展的实际行为）；
 * - `convention`：只设置 PI_SUBAGENT_PARENT_SESSION；
 * - `none`：都不设置（对照组：没有父会话时 pi-permission-system 应当拒绝，命令不执行）；
 * - `--delay`：模拟管理员过几秒才点（验证心跳能让子会话等过宽限期），默认 1.5 秒；
 * - `--keep`：保留临时目录，便于查看收到的原始请求（`seen-requests/`）和 pi-permission-system 的审查日志。
 *
 * 环境变量：
 * - `PI_BIN`：pi 可执行文件，默认从 PATH 里找（会跳过 node_modules/.bin，避免用到依赖里的旧版本 pi）；
 * - `PI_HOME`：你平时的 pi 配置目录（默认 `~/.pi/agent`），从这里链接 `auth.json` 与 `models.json` 以便调用模型；
 * - `PS_PACKAGE`：pi-permission-system 包目录，默认 `$PI_HOME/npm/node_modules/@gotgenes/pi-permission-system`；
 * - `E2E_PROVIDER` / `E2E_MODEL`：使用的模型（不设时用 pi 的默认模型）。
 *
 * 判据是命令的副作用：命令把一个随机串写进工作目录里的文件，脚本检查文件内容。
 * 不能只看 pi 的输出 —— `echo` 的输出是可以猜到的，模型没执行命令也可能直接答出来；
 * 也不能看 pi 的退出码 —— 命令被拒绝时 pi 同样正常退出。为防止模型改用写文件工具绕过，
 * 测试配置里 write / edit 工具是禁用的。脚本按模式判定通过与否，通过时退出码 0，否则 1。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	PS_FORWARDING_PARENT_ENV_KEYS,
	PsForwardingServer,
	psForwardingHeartbeatPath,
	psForwardingRequestsDir,
	psForwardingResponsesDir,
	psForwardingRootDir,
} from "../../src/approval/ps-forwarding.js";

type Mode = "both" | "convention" | "none";

const args = process.argv.slice(2);
const mode = (args.find((a) => ["both", "convention", "none"].includes(a)) ?? "both") as Mode;
const delayIndex = args.indexOf("--delay");
const answerDelayMs = delayIndex >= 0 ? Number(args[delayIndex + 1]) * 1000 : 1500;
const keep = args.includes("--keep");

const TOKEN = `ps-fwd-e2e-${randomBytes(6).toString("hex")}`;
const OUTPUT_FILE = "ps-fwd-e2e.txt";
const PARENT_ID = "ps-fwd-e2e-parent";
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

/** 在临时目录里准备一个只装了 pi-permission-system 的 pi 配置目录，并给 `echo` 配一条「询问」规则。 */
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
		...(process.env.E2E_PROVIDER ? { defaultProvider: process.env.E2E_PROVIDER } : {}),
		...(process.env.E2E_MODEL ? { defaultModel: process.env.E2E_MODEL } : {}),
		defaultThinkingLevel: "minimal",
		defaultProjectTrust: "always",
	}, null, 2));
	writeFileSync(join(agentDir, "extensions", "pi-permission-system", "config.json"), JSON.stringify({
		permissionReviewLog: true,
		yoloMode: false,
		permission: { "*": "allow", write: "deny", edit: "deny", bash: { "*": "allow", "echo *": "ask" } },
	}, null, 2));
	return agentDir;
}

function childEnv(agentDir: string, path: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, PI_CODING_AGENT_DIR: agentDir };
	for (const key of PS_FORWARDING_PARENT_ENV_KEYS) delete env[key];
	if (mode !== "none") env.PI_SUBAGENT_PARENT_SESSION = PARENT_ID;
	if (mode === "both") env.PI_AGENT_ROUTER_PARENT_SESSION_ID = PARENT_ID;
	return env;
}

async function main(): Promise<boolean> {
	const root = mkdtempSync(join(tmpdir(), "ps-fwd-e2e-"));
	const agentDir = prepareAgentDir(root);
	const workDir = join(root, "work");
	mkdirSync(workDir);
	const forwardingDir = psForwardingRootDir(agentDir);
	const cards: unknown[] = [];

	const server = new PsForwardingServer({
		forwardingDir,
		parentSessionId: PARENT_ID,
		// 真实部署里按会话 id 查飞书会话；这里只有一个会话，固定路由即可
		routeForSessionId: () => ({ conversationKey: "oc_e2e", chatId: "oc_e2e", sourceMessageId: "om_e2e", runId: "run-e2e" }),
		allowedOperatorIds: () => ["ou_e2e_admin"],
		requestDecision: async (input) => {
			cards.push(input);
			// 留存原始请求文件（--keep 时可对照 pi-permission-system 实际写了什么）
			const requestsDir = psForwardingRequestsDir(forwardingDir, PARENT_ID);
			mkdirSync(join(root, "seen-requests"), { recursive: true });
			for (const name of readdirSync(requestsDir).filter((n) => n.endsWith(".json"))) {
				writeFileSync(join(root, "seen-requests", name), readFileSync(join(requestsDir, name)));
			}
			log("审批卡：", JSON.stringify({ toolName: input.toolName, paramsText: input.paramsText, reason: input.reason, choices: input.choices }));
			await new Promise((resolve) => setTimeout(resolve, answerDelayMs));
			log("模拟管理员点「仅本次」");
			return { verdict: "approved", choice: "once", operatorId: "ou_e2e_admin" };
		},
		log: (level, msg, meta) => { if (level !== "debug") log(`${level}: ${msg}`, meta ?? ""); },
	});
	server.start();
	const heartbeat = psForwardingHeartbeatPath(forwardingDir, PARENT_ID);
	log("心跳文件：", existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : "（缺失）");

	const path = cleanPath();
	const pi = findPi(path);
	const prompt = `用 bash 工具执行 \`echo ${TOKEN} > ${OUTPUT_FILE}\`，完成后回复「完成」。如果命令没能执行，照实说明原因。`;
	log("启动", pi);
	const child = spawn(pi, ["-p", prompt], { cwd: workDir, env: childEnv(agentDir, path), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	const startedAt = Date.now();
	const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
	await server.stop();

	const leftover = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
	const requests = leftover(psForwardingRequestsDir(forwardingDir, PARENT_ID));
	const responses = leftover(psForwardingResponsesDir(forwardingDir, PARENT_ID));
	const outputPath = join(workDir, OUTPUT_FILE);
	const executed = existsSync(outputPath) && readFileSync(outputPath, "utf8").trim() === TOKEN;
	log("pi 退出码", code, "耗时", `${Date.now() - startedAt}ms`);
	log("pi 输出：", stdout.trim() || "（空）");
	if (stderr.trim()) log("pi 错误输出（末尾）：", stderr.trim().slice(-2000));
	log("命令执行了", executed, "审批卡数量", cards.length, "残留请求", requests, "残留响应", responses);

	const expectExecuted = mode !== "none";
	const passed = executed === expectExecuted && cards.length === (expectExecuted ? 1 : 0) && requests.length === 0 && responses.length === 0;
	log(passed ? "通过" : "失败", expectExecuted ? "（期望：弹一次卡，命令执行，无残留文件）" : "（期望：不弹卡，命令被拒绝）");

	if (keep) log("临时目录已保留：", root);
	else rmSync(root, { recursive: true, force: true });
	return passed;
}

process.exit((await main()) ? 0 : 1);
