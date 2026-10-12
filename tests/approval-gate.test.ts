/**
 * 工具调用审批检查（approval/gate.ts）：各判定分支与日志。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolGate } from "../src/approval/gate.js";
import type { PermissionBridge } from "../src/approval/permission-bridge.js";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import type { BridgeGateInput } from "../src/session/pi-bridge-hooks.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";

type GateOutcome = { decision: "allow" | "deny" | "ask"; verdict?: "approved" | "denied" | "timeout" };

function setup(opts: { approval?: Partial<BridgeConfig["approval"]>; admins?: string[]; outcome?: GateOutcome; psInstalled?: boolean; noBridge?: boolean } = {}) {
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, admins: opts.admins ?? ["ou_admin"], approval: { ...DEFAULT_CONFIG.approval, mode: "builtin", ...opts.approval } };
	const gated: BridgeGateInput[] = [];
	const outcome = opts.outcome ?? { decision: "ask", verdict: "approved" };
	if (!opts.noBridge) {
		rt.permissionBridge = {
			gate: async (input: BridgeGateInput) => {
				gated.push({ ...input });
				return { decision: outcome.decision, ...(outcome.verdict ? { verdict: Promise.resolve(outcome.verdict) } : {}) };
			},
		} as unknown as PermissionBridge;
	}
	const logs: string[] = [];
	const push = (m: string) => { logs.push(m); };
	const log = { debug: push, info: push, warn: push, error: push };
	const gate = createToolGate({ rt, log, psInstalled: () => opts.psInstalled ?? false });
	return { gate, gated, logs, rt };
}

const input = (over: Partial<BridgeGateInput> = {}): BridgeGateInput => ({
	conversationKey: "oc_dm", sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "write",
	paramsText: "{}", chatId: "oc_dm", senderId: "ou_user", allowedOperatorIds: ["ou_admin"], ...over,
});

test("审批检查：桥未启动时不拦截", async () => {
	const { gate } = setup({ noBridge: true });
	assert.equal(await gate(input()), undefined);
});

test("审批检查：审批卡的三种结论映射为放行 / 拒绝 / 超时拒绝", async () => {
	assert.equal(await setup({ outcome: { decision: "ask", verdict: "approved" } }).gate(input()), undefined);
	assert.deepEqual(await setup({ outcome: { decision: "ask", verdict: "denied" } }).gate(input()), { block: true, reason: "飞书审批已拒绝" });
	assert.deepEqual(await setup({ outcome: { decision: "ask", verdict: "timeout" } }).gate(input()), { block: true, reason: "飞书审批超时，已拒绝" });
	assert.equal(await setup({ outcome: { decision: "allow" } }).gate(input()), undefined);
	assert.deepEqual(await setup({ outcome: { decision: "deny" } }).gate(input()), { block: true, reason: "工具调用被策略拒绝" });
});

test("审批检查：管理员免审只看显式传入的 senderId", async () => {
	const on = setup({ approval: { adminSkipApproval: true }, outcome: { decision: "deny" } });
	assert.equal(await on.gate(input({ senderId: "ou_admin" })), undefined);
	assert.ok(on.logs.includes("feishu.approval.admin_skip"));
	assert.equal(on.gated.length, 0);
	assert.deepEqual(await on.gate(input({ senderId: "ou_user" })), { block: true, reason: "工具调用被策略拒绝" });
	const off = setup({ outcome: { decision: "deny" } });
	assert.deepEqual(await off.gate(input({ senderId: "ou_admin" })), { block: true, reason: "工具调用被策略拒绝" }, "开关关闭时管理员也要审批");
});

test("审批检查：模式为 off 时一律放行，不进审批卡，危险命令也不拦", async () => {
	const off = setup({ approval: { mode: "off" }, outcome: { decision: "deny" } });
	assert.equal(await off.gate(input()), undefined);
	assert.equal(await off.gate(input({ toolName: "bash", command: "rm -rf /" })), undefined);
	assert.equal(off.gated.length, 0);
	const unset = setup({ approval: { mode: undefined }, outcome: { decision: "deny" } });
	assert.equal(await unset.gate(input()), undefined, "没配置 = off");
});

test("审批检查：会话覆盖优先于全局模式，只影响该会话", async () => {
	const s = setup({ approval: { mode: "off" }, outcome: { decision: "deny" } });
	s.rt.approvalModeOverrides.set("oc_dm", "builtin");
	assert.deepEqual(await s.gate(input()), { block: true, reason: "工具调用被策略拒绝" });
	assert.equal(await s.gate(input({ conversationKey: "oc_other" })), undefined, "其他会话仍按全局 off");

	const g = setup({ approval: { mode: "builtin" }, outcome: { decision: "deny" } });
	g.rt.approvalModeOverrides.set("oc_dm", "off");
	assert.equal(await g.gate(input()), undefined);
	assert.deepEqual(await g.gate(input({ conversationKey: "oc_other" })), { block: true, reason: "工具调用被策略拒绝" });
});

test("审批检查：环境变量 FEISHU_CHANNEL_APPROVAL_MODE 优先于配置文件", async () => {
	process.env.FEISHU_CHANNEL_APPROVAL_MODE = "off";
	try {
		const s = setup({ approval: { mode: "builtin" }, outcome: { decision: "deny" } });
		assert.equal(await s.gate(input()), undefined);
	} finally {
		delete process.env.FEISHU_CHANNEL_APPROVAL_MODE;
	}
});

test("审批检查：模式为 pi-permission-system 时，PS 已安装则放行，未安装则退回内置审批并报错", async () => {
	const installed = setup({ approval: { mode: "pi-permission-system" }, psInstalled: true, outcome: { decision: "deny" } });
	assert.equal(await installed.gate(input()), undefined);
	assert.equal(installed.gated.length, 0);

	const missing = setup({ approval: { mode: "pi-permission-system" }, psInstalled: false, outcome: { decision: "deny" } });
	assert.deepEqual(await missing.gate(input()), { block: true, reason: "工具调用被策略拒绝" });
	assert.ok(missing.logs.includes("feishu.approval.plugin_unavailable"));
});

test("审批检查：bash 命令分级——只读放行、危险拒绝、其余带理由进入审批", async () => {
	const readOnly = setup({ outcome: { decision: "deny" } });
	assert.equal(await readOnly.gate(input({ toolName: "bash", command: "ls -la" })), undefined);
	assert.ok(readOnly.logs.includes("feishu.approval.command_allow"));

	const danger = setup();
	const denied = await danger.gate(input({ toolName: "bash", command: "rm -rf /" }));
	assert.equal(denied?.block, true);
	assert.match(denied?.reason ?? "", /安全策略拒绝/);
	assert.equal(danger.gated.length, 0, "危险命令不弹卡");

	const ask = setup();
	await ask.gate(input({ toolName: "bash", command: "npm install left-pad" }));
	assert.ok(ask.logs.includes("feishu.approval.command_ask"));
	assert.equal(ask.gated.length, 1);
	assert.ok(ask.gated[0].reason, "审批卡带上需要审批的理由");
});

test("审批检查：关闭命令分级后 bash 一律进入审批", async () => {
	const { gate, gated } = setup({ approval: { commandPolicy: { enabled: false } } });
	await gate(input({ toolName: "bash", command: "ls" }));
	assert.equal(gated.length, 1);
});
