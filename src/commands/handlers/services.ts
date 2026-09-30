/**
 * 命令处理函数依赖的运行态与服务（由入口提供）。处理函数只通过它访问桥，不直接 import 入口。
 */
import type { UsageProvider } from "../../outbound/usage-provider.js";
import type { BridgeRuntime } from "../../runtime/bridge-runtime.js";
import type { DiagnosticsContext } from "../../runtime/diagnostics.js";
import type { BridgeLogger } from "../../runtime/logger.js";
import type { PiCommandInfo } from "../dispatch.js";

export interface CommandServices {
	rt: BridgeRuntime;
	log: BridgeLogger;
	/** pi 侧的命令/模板/技能（帮助里列出）。 */
	piCommands(): PiCommandInfo[];
	/** `/feishu status` 的正文。 */
	statusText(): string;
	/** 诊断上下文（只含计数与枚举，供 doctor/导出复用）。 */
	diagnosticsContext(): DiagnosticsContext;
	/** 账户用量提供方（首次用到才建）。 */
	usageProvider(): UsageProvider;
}
