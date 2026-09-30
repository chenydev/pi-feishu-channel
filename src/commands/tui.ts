/**
 * pi 终端界面（TUI）里的 `/feishu:*` 命令：状态、启停、「始终批准」规则、单群策略、debug 日志。
 *
 * TUI 是本地操作（能开 TUI 的人本来就持有进程），不做身份校验；飞书侧的同名命令有管理员校验。
 */
import { saveConfigFields } from "../config.js";
import type { ExtensionAPI } from "../pi-types.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { GroupPolicy } from "../types.js";
import { VALID_POLICIES, alwaysApprovedCommand, setChatPolicy } from "./handlers/admin.js";

export function registerTuiCommands(pi: ExtensionAPI, deps: {
	rt: BridgeRuntime;
	log: BridgeLogger;
	statusText(): string;
	start(): Promise<string>;
	stop(): Promise<string>;
}): void {
	const { rt, log } = deps;
	pi.registerCommand("feishu:status", {
		description: "飞书桥状态",
		handler: () => deps.statusText(),
	});
	pi.registerCommand("feishu:start", {
		description: "启动飞书桥",
		handler: async () => deps.start(),
	});
	pi.registerCommand("feishu:stop", {
		description: "停止飞书桥",
		handler: async () => deps.stop(),
	});
	pi.registerCommand("feishu:restart", {
		description: "重启飞书桥",
		handler: async () => {
			await deps.stop();
			return deps.start();
		},
	});
	// 撤销入口：「始终批准」是一条**持久放行**，必须能看、能撤。
	// 没有它，一次点击就等于永久放开一部分审批，而且无人能收回。
	pi.registerCommand("feishu:always", {
		description: "查看/撤销「始终批准」规则：/feishu:always [revoke <规则名>]",
		handler: (_args, _ctx, args: string[]) => alwaysApprovedCommand({ rt, log }, args ?? [], { prefix: "/feishu:always" }),
	});
	pi.registerCommand("feishu:policy", {
		description: "设置单群策略：/feishu:policy <chatId> <open|mention|disabled|allowlist|blacklist|admin_only>",
		handler: (_args, _ctx, args: string[]) => {
			const [chatId, policy] = args;
			if (!chatId || !policy || !VALID_POLICIES.includes(policy as GroupPolicy)) return `用法：/feishu:policy <chatId> <${VALID_POLICIES.join("|")}>`;
			return setChatPolicy({ rt }, chatId, policy as GroupPolicy) ? `已设置 ${chatId} → ${policy}（已落盘）` : "落盘失败，运行态未修改";
		},
	});
	pi.registerCommand("feishu:debug", {
		description: "开关 debug 日志：/feishu:debug on|off",
		handler: (_args, _ctx, args: string[]) => {
			const flag = args[0];
			if (flag !== "on" && flag !== "off") return "用法：/feishu:debug on|off";
			rt.config.debug = flag === "on";
			saveConfigFields(rt.homeDir, rt.config, ["debug"]);
			return `debug = ${rt.config.debug}`;
		},
	});
}
