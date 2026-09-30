import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/config.js";
import { FEATURE_SWITCHES, enabledFeatures } from "../src/features/switches.js";
import { runDoctor } from "../src/runtime/doctor.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";

const base = (): BridgeConfig => structuredClone(DEFAULT_CONFIG);

/** 每个开关「打开」时的最小配置改动。 */
const TURN_ON: Record<string, (c: BridgeConfig) => void> = {
	cron: (c) => { c.cron = { enabled: true }; },
	alerts: (c) => { c.alerts = { enabled: true }; },
	stt: (c) => { c.stt = { provider: "openai", endpoint: "http://stt.invalid/v1" }; },
	docComments: (c) => { c.docComments = { enabled: true }; },
	meetingInvite: (c) => { c.meetingInvite = { enabled: true }; },
	cardTool: (c) => { c.cardTool = { enabled: true }; },
	docTools: (c) => { c.docTools = { enabled: true }; },
	directBash: (c) => { c.directBash = { enabled: true }; },
	longReply: (c) => { c.longReply = { asFile: true }; },
	retention: (c) => { c.retention = { sessionDays: 30 }; },
	accessRequest: (c) => { c.onboarding = { accessRequest: true }; },
	streamingCard: (c) => { c.streamingCard = { enabled: true, throttleMs: 1000 }; },
	psForwarding: (c) => {
		c.approval = { ...c.approval, policyEngine: "pi-permission-system", forwarding: { enabled: true } };
	},
};

test("能力清单：默认配置下没有任何能力打开", () => {
	assert.deepEqual(enabledFeatures(base()), []);
});

test("能力清单：每个开关单独打开时，清单里只多出它自己", () => {
	assert.deepEqual(
		Object.keys(TURN_ON).sort(),
		FEATURE_SWITCHES.map((feature) => feature.name).sort(),
		"测试必须覆盖全部登记的开关",
	);
	for (const [name, turnOn] of Object.entries(TURN_ON)) {
		const config = base();
		turnOn(config);
		assert.deepEqual(enabledFeatures(config), [name], `只打开 ${name}`);
	}
});

test("能力清单：判定与实际生效条件一致", () => {
	const sttWithoutEndpoint = base();
	sttWithoutEndpoint.stt = { provider: "openai" };
	assert.deepEqual(enabledFeatures(sttWithoutEndpoint), [], "没有 endpoint 时转写器不会创建");

	const forwardingWithoutPolicyEngine = base();
	forwardingWithoutPolicyEngine.approval = { ...forwardingWithoutPolicyEngine.approval, forwarding: { enabled: true } };
	assert.deepEqual(enabledFeatures(forwardingWithoutPolicyEngine), [], "策略引擎没有让权时转发开关不生效");

	const retentionZero = base();
	retentionZero.retention = { sessionDays: 0 };
	assert.deepEqual(enabledFeatures(retentionZero), [], "sessionDays=0 表示不归档");
});

test("能力清单：/feishu doctor 以信息项列出已打开的能力", () => {
	const paths = resolvePaths(mkdtempSync(join(tmpdir(), "pi-feishu-channel-features-")));
	const find = (config: BridgeConfig) => runDoctor({ config, paths }).find((check) => check.name === "features");

	const off = find(base());
	assert.equal(off?.ok, true, "信息项不判对错");
	assert.match(off?.detail ?? "", /无/);

	const config = base();
	TURN_ON.cron(config);
	TURN_ON.streamingCard(config);
	assert.equal(find(config)?.detail, "已启用：cron、streamingCard");
});
