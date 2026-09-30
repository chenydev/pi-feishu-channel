/**
 * 命令类卡片：帮助、会话列表、欢迎、群放行提示。
 *
 * 按钮统一走 `op: "command"`：点击 = 以点击人身份发送该命令（桥侧构造合成消息走同一个命令处理函数），
 * 因此按钮能做的事不会超过"自己打这条命令"能做的事。
 */
import { COMMANDS, type CommandGroup, type CommandSpec } from "./registry.js";

/** 合成命令消息需要的会话上下文（点击回调里拿不到入站消息）。 */
export interface CommandButtonContext {
	chatType: "p2p" | "group" | "topic";
	threadId?: string;
	/** 发起人：按钮只允许发起人或管理员点（群里看得到卡的人不一定是会话主人）。 */
	ownerOpenId?: string;
}

export function commandButton(label: string, command: string, ctx: CommandButtonContext, type: "primary" | "default" | "danger" = "default"): unknown {
	return {
		tag: "button", size: "small", type,
		text: { tag: "plain_text", content: label },
		value: {
			op: "command", command, chatType: ctx.chatType,
			...(ctx.threadId ? { threadId: ctx.threadId } : {}),
			...(ctx.ownerOpenId ? { owner: ctx.ownerOpenId } : {}),
		},
	};
}

/** 按钮每行 3 个等宽（不嵌套 column_set —— 飞书会拒卡）。 */
function buttonRows(buttons: unknown[], perRow = 3): unknown[] {
	const rows: unknown[] = [];
	for (let i = 0; i < buttons.length; i += perRow) {
		const slice = buttons.slice(i, i + perRow);
		const columns = slice.map((button) => ({ tag: "column", width: "weighted", weight: 1, elements: [button] }));
		for (let k = slice.length; k < perRow; k++) columns.push({ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: " " }] as never });
		rows.push({ tag: "column_set", flex_mode: "none", horizontal_spacing: "small", columns });
	}
	return rows;
}

export interface HelpCardInput extends CommandButtonContext {
	isAdmin: boolean;
	piCommands?: Array<{ name: string; description?: string; source?: string }>;
	directBash?: boolean;
}

/** 分组帮助卡。无参命令做成按钮；管理命令只对管理员展示按钮。 */
export function buildHelpCard(input: HelpCardInput, specs: readonly CommandSpec[] = COMMANDS): unknown {
	const groups = new Map<CommandGroup, CommandSpec[]>();
	for (const spec of specs) groups.set(spec.group, [...(groups.get(spec.group) ?? []), spec]);
	const elements: unknown[] = [];
	for (const [group, list] of groups) {
		elements.push({ tag: "markdown", content: `**${group}**` });
		const lines = list.map((spec) => {
			const aliases = spec.aliases?.length ? `（${spec.aliases.join("、")}）` : "";
			return `\`${spec.usage}\`${aliases}${spec.adminOnly ? " 〔管理员〕" : ""}　${spec.description}`;
		});
		elements.push({ tag: "markdown", text_size: "notation", content: lines.join("\n") });
		const buttons = list
			.filter((spec) => spec.button && (!spec.adminOnly || input.isAdmin))
			.map((spec) => commandButton(spec.name, spec.name, input));
		elements.push(...buttonRows(buttons));
		elements.push({ tag: "hr" });
	}
	const extras = (input.piCommands ?? []).filter((command) => command.source !== "extension").slice(0, 30);
	if (extras.length > 0) {
		elements.push({
			tag: "collapsible_panel",
			expanded: false,
			header: { title: { tag: "markdown", content: `**技能与模板（${extras.length}）**` } },
			elements: [{
				tag: "markdown", text_size: "notation",
				content: extras.map((command) => `\`/${command.name}\`${command.description ? `　${command.description.slice(0, 60)}` : ""}`).join("\n"),
			}],
		});
	}
	elements.push({
		tag: "markdown", text_size: "notation",
		content: [
			"忙碌时直接发普通消息 = 并入当前任务；要等当前任务结束再做用 `/queue`。",
			...(input.directBash ? ["管理员可以用 `!<命令>` 直接执行命令（不经过模型）。"] : []),
		].join("\n"),
	});
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: "命令帮助" }, template: "blue" },
		body: { elements },
	};
}

export interface SessionsCardEntry {
	selector: string;
	name: string;
	when: string;
	count: string;
	isCurrent: boolean;
}

/** 会话列表卡。每行一个"恢复"按钮（当前会话不给）。 */
export function buildSessionsCard(entries: SessionsCardEntry[], ctx: CommandButtonContext, footer: string): unknown {
	const elements: unknown[] = [];
	for (const entry of entries) {
		elements.push({
			tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
			columns: [
				{
					tag: "column", width: "weighted", weight: 4,
					elements: [{ tag: "markdown", content: `**${entry.selector}** ${entry.name}${entry.isCurrent ? "　·　当前" : ""}\n<font color='grey'>${entry.when} · ${entry.count}</font>` }],
				},
				{
					tag: "column", width: "weighted", weight: 1, vertical_align: "center",
					elements: entry.isCurrent ? [{ tag: "markdown", content: " " }] : [commandButton("恢复", `/resume ${entry.selector}`, ctx, "primary")],
				},
			],
		});
	}
	elements.push({ tag: "hr" });
	elements.push({ tag: "markdown", text_size: "notation", content: footer });
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: "本会话历史" }, template: "blue" },
		body: { elements },
	};
}

/** /new 回执卡：带上一个会话的名字和"恢复"按钮（误操作能找回）。 */
export function buildNewSessionCard(text: string, previous: { name?: string; selector: string } | undefined, ctx: CommandButtonContext): unknown {
	const elements: unknown[] = [{ tag: "markdown", content: text }];
	if (previous) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
			columns: [
				{ tag: "column", width: "weighted", weight: 3, elements: [{ tag: "markdown", content: `上一个会话：**${previous.name || "未命名会话"}**` }] },
				{ tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [commandButton("恢复", `/resume ${previous.selector}`, ctx)] },
			],
		});
	}
	return { schema: "2.0", config: { wide_screen_mode: true }, body: { elements } };
}

/** 入群欢迎卡。 */
export function buildWelcomeCard(input: { botName?: string; trigger: string; ctx: CommandButtonContext }): unknown {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `👋 ${input.botName ?? "机器人"} 来了` }, template: "green" },
		body: {
			elements: [
				{ tag: "markdown", content: `我可以读写代码、执行命令、查资料，并把结果发回这里。\n**触发方式**：${input.trigger}` },
				...buttonRows([commandButton("/help", "/help", input.ctx, "primary"), commandButton("/model", "/model", input.ctx)]),
			],
		},
	};
}

/** 未放行群被 @ 或被拉进群 → 私聊管理员的放行卡。 */
export function buildAllowChatCard(input: { chatId: string; chatName?: string; reason: string; operatorName?: string }): unknown {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: "群未放行" }, template: "orange" },
		body: {
			elements: [
				{
					tag: "markdown",
					content: [
						`群：**${input.chatName ?? "未知群"}**（\`${input.chatId}\`）`,
						`情况：${input.reason}${input.operatorName ? `（${input.operatorName}）` : ""}`,
						"该群不在 `allowChats` 中，机器人不会响应。",
					].join("\n"),
				},
				{
					tag: "button", type: "primary", size: "medium",
					text: { tag: "plain_text", content: "放行此群" },
					value: { op: "chat.allow", chatId: input.chatId },
				},
			],
		},
	};
}

function at(openId: string): string {
	return `<at id=${openId}></at>`;
}

export interface AccessRequestCardInput {
	/** group = 发在该群里（回复申请人的消息）；dm = 私聊审批人。 */
	mode: "group" | "dm";
	chatId: string;
	chatName?: string;
	requesterId: string;
	approvers: string[];
	/** 带角色的审批人描述（"应用归属人 <at> 、应用协作者 <at>"）；缺省只列 @。 */
	approverLabel?: string;
	/** 谁能点（"仅应用归属人"）；缺省不写。 */
	approverHint?: string;
}

/**
 * 开通申请审批卡：@ 申请人与审批人；按钮只有管理员能点（回调里校验）。
 * 按钮带上申请人，放行 / 暂不放行后要在群里回告他。
 */
export function buildAccessRequestCard(input: AccessRequestCardInput): unknown {
	const who = input.approverLabel ?? input.approvers.map(at).join(" ");
	const content = input.mode === "group"
		? [
			`${at(input.requesterId)} @ 了机器人，但本群还没有开通。`,
			`请 ${who} 审批是否放行本群${input.approverHint ? `（${input.approverHint}可操作）` : ""}。`,
		]
		: [
			`${who}：有人申请在群里使用机器人`,
			`群：**${input.chatName ?? "未知群"}**（\`${input.chatId}\`）`,
			`申请人：${at(input.requesterId)}`,
			"该群不在 `allowChats` 中，放行后群里 @ 机器人即可使用。",
		];
	const value = { chatId: input.chatId, requester: input.requesterId };
	const button = (label: string, op: string, type: "primary" | "default") => ({
		tag: "column", width: "weighted", weight: 1,
		elements: [{ tag: "button", type, size: "medium", text: { tag: "plain_text", content: label }, value: { op, ...value } }],
	});
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: "机器人开通申请" }, template: "orange" },
		body: {
			elements: [
				{ tag: "markdown", content: content.join("\n") },
				{
					tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
					columns: [button("放行此群", "chat.allow", "primary"), button("暂不放行", "chat.deny", "default")],
				},
			],
		},
	};
}

/** 群里给申请人的回告（无按钮；@ 才会有提醒）。 */
export function buildAccessNoticeCard(text: string, template: "blue" | "green" | "grey" = "blue"): unknown {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: template === "green" ? "本群已开通" : "机器人开通申请" }, template },
		body: { elements: [{ tag: "markdown", content: text }] },
	};
}

/** 把一组 open_id 渲染成 @（卡片 markdown）。 */
export function atList(openIds: string[]): string {
	return openIds.map(at).join(" ");
}

/** 回调后把卡片换成一行结果（按钮失效，避免重复点）。 */
export function buildResultCard(text: string, template: "green" | "grey" | "red" = "green"): unknown {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: template === "red" ? "未完成" : "已处理" }, template },
		body: { elements: [{ tag: "markdown", content: text }] },
	};
}
