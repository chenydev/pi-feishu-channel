/**
 * 核心卡片按钮的处理函数（登记到 `CardRouter`）：
 * - `model`：/model 状态卡上的思考等级、模型表格展开/收起、模型切换；
 * - `command`：命令按钮（以点击人身份发送一条命令）；
 * - `clarify`：澄清提问的选项；
 * - `approval`：审批卡。
 *
 * 可选能力的按钮（群开通申请、agent 自定义卡片）由各能力自己登记。
 */
import { randomBytes } from "node:crypto";
import type { ApprovalChoice } from "../approval/permission-bridge.js";
import { buildApprovalCard, type ApprovalCardResolution } from "../approval/cards.js";
import { buildModelStatusCard } from "../commands/models-card.js";
import { resolveCommand } from "../commands/registry.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { FeishuInboundMessage } from "../types.js";
import { buildClarificationResultCard } from "./clarification-store.js";
import type { CardOps, CardRouterLog } from "./card-router.js";

export interface CardOpsContext {
	rt: BridgeRuntime;
	log: CardRouterLog;
	admins: () => readonly string[];
	/** 以合成消息执行一条斜杠命令（与用户在聊天里发送等价）。 */
	runCommand: (msg: FeishuInboundMessage) => Promise<unknown>;
}

const ownerOf = (value: Record<string, unknown>) => (typeof value.owner === "string" ? { ownerOpenId: value.owner } : {});

/** /model 状态卡。三个按钮都会改会话状态，走会话类授权。 */
export function modelCardOps({ rt, log }: CardOpsContext): CardOps {
	return {
		// 点档位按钮即切换思考等级（等价于 /thinking <level>），然后原地刷新卡片 ——
		// 按钮的勾与禁用态要跟着变，否则用户会以为没生效。
		"thinking.set": {
			sessionScoped: true,
			run: async (_action, value) => {
				if (typeof value.level !== "string" || typeof value.conversationKey !== "string") return undefined;
				const result = await rt.convManager?.commands.setThinkingByKey(value.conversationKey, value.level);
				if (!result?.ok) {
					log.warn("feishu.card.thinking_set_failed", { level: value.level, reason: result?.reason ?? "unknown" });
					return { toast: { type: "warning", content: result?.reason ?? "切换失败" } };
				}
				log.info("feishu.card.thinking_set", { level: value.level, conversationKey: value.conversationKey });
				const data = await rt.convManager?.commands.modelStatusCardDataByKey(value.conversationKey);
				if (!data) return { toast: { type: "success", content: `已切换到 ${value.level}` } };
				// 把这次执行的命令写进卡片：用户点的是按钮，但等价于发了一条斜杠命令，
				// 露出来才能复制去加 -g（全局默认）或转发给别人。
				return {
					toast: { type: "success", content: `已切换到 ${value.level}` },
					card: { type: "raw", data: buildModelStatusCard({ ...data, ...ownerOf(value), lastExecuted: `/thinking ${value.level}` }) },
				};
			},
		},
		// 模型表格**在同一张卡里展开/收起**（不另发一张卡）。展开态不记忆：任何一次刷新都回到收起 ——
		// 表格是临时查阅用的，用户要的是随时能回到干净的状态卡。
		"models.toggle": {
			sessionScoped: true,
			run: async (_action, value) => {
				if (typeof value.conversationKey !== "string") return undefined;
				const expanded = value.expanded === true;
				const data = await rt.convManager?.commands.modelStatusCardDataByKey(value.conversationKey);
				if (!data) {
					log.warn("feishu.card.models_toggle_failed", { conversationKey: value.conversationKey });
					return { toast: { type: "warning", content: "会话已失效，请重新发送 /model" } };
				}
				log.info("feishu.card.models_toggle", { expanded, conversationKey: value.conversationKey });
				// 展开时给回执（等价命令就是 /models）；收起不给 —— 「收起」没有对应的斜杠命令。
				return {
					card: {
						type: "raw",
						data: buildModelStatusCard({ ...data, ...ownerOf(value), expanded, ...(expanded ? { lastExecuted: "/models" } : {}) }),
					},
				};
			},
		},
		// 最近使用 / 快速切换
		"model.set": {
			sessionScoped: true,
			run: async (action, value) => {
				if (typeof value.model !== "string" || typeof value.conversationKey !== "string") return undefined;
				const result = await rt.convManager?.commands.setModelByKey(value.conversationKey, value.model);
				if (!result?.ok) return { toast: { type: "warning", content: result?.reason ?? "切换失败" } };
				log.info("feishu.card.model_set", { model: value.model, conversationKey: value.conversationKey, operator: action.operatorOpenId });
				const data = await rt.convManager?.commands.modelStatusCardDataByKey(value.conversationKey);
				if (!data) return { toast: { type: "success", content: `已切换到 ${value.model}` } };
				return {
					toast: { type: "success", content: `已切换到 ${value.model}` },
					card: { type: "raw", data: buildModelStatusCard({ ...data, ...ownerOf(value), lastExecuted: `/model ${value.model}` }) },
				};
			},
		},
	};
}

/** 命令按钮：以点击人身份"发送"该命令（只接受注册表里的命令）。 */
export function commandCardOps({ log, admins, runCommand }: CardOpsContext): CardOps {
	return {
		command: (action, value) => {
			if (typeof value.command !== "string" || !action.chatId || !resolveCommand(value.command)) return undefined;
			const ownerId = typeof value.owner === "string" ? value.owner : undefined;
			if (ownerId && ownerId !== action.operatorOpenId && !admins().includes(action.operatorOpenId)) {
				return { toast: { type: "warning", content: "只有发起人或管理员可以操作这张卡片" } };
			}
			const chatType = value.chatType === "p2p" || value.chatType === "topic" ? value.chatType : "group";
			const nonce = `#${action.token ?? randomBytes(6).toString("hex")}`;
			const synthetic: FeishuInboundMessage = {
				messageId: action.messageId, dedupeNonce: nonce, replyTarget: action.messageId, synthetic: true,
				chatId: action.chatId, chatType, ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
				senderId: action.operatorOpenId, isBot: false, msgType: "text", text: value.command,
				mentions: [], resources: [], raw: undefined, ts: Date.now(),
			};
			// 后台执行：命令可能要建会话（首次几秒），不占卡片回调的 3 秒时限
			void runCommand(synthetic).catch((error: unknown) => {
				log.warn("feishu.card.command_failed", { command: value.command, error: error instanceof Error ? error.message : String(error) });
			});
			return { toast: { type: "info", content: `已执行 ${value.command}` } };
		},
	};
}

/** 澄清选择：只恢复等待点，不写任何授权。 */
export function clarifyCardOps({ rt }: CardOpsContext): CardOps {
	return {
		clarify: (action, value) => {
			if (typeof value.clarificationId !== "string" || typeof value.token !== "string" || typeof value.choice !== "string") return undefined;
			const decided = rt.clarificationStore?.decide({
				id: value.clarificationId, token: value.token, messageId: action.messageId,
				chatId: action.chatId ?? "", operatorOpenId: action.operatorOpenId, choice: value.choice,
			});
			if (!decided?.ok) return { toast: { type: "warning", content: decided?.reason ?? "该提问已失效" } };
			return {
				toast: { type: "success", content: decided.reason },
				card: { type: "raw", data: buildClarificationResultCard(value.choice, action.operatorOpenId) },
			};
		},
	};
}

/** 审批卡：token 与操作者由 PermissionBridge 校验。 */
export function approvalCardOps({ rt }: CardOpsContext): CardOps {
	return {
		approval: (action, value) => {
			if (typeof value.approvalId !== "string" || typeof value.token !== "string") return undefined;
			const choice = value.choice;
			if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") return undefined;
			const decision = rt.permissionBridge?.decide({
				id: value.approvalId, token: value.token, messageId: action.messageId, chatId: action.chatId,
				operatorOpenId: action.operatorOpenId, choice: choice as ApprovalChoice,
			});
			if (!decision?.ok) return { toast: { type: "warning", content: decision?.reason ?? "审批已失效" } };
			// 原地更新同一张卡：保留原文与参数，标题改成结论、被选项加 ✓、其余禁用。
			const resolution: ApprovalCardResolution = {
				choice: choice as ApprovalChoice,
				resultText: decision.reason,
				operatorOpenId: action.operatorOpenId,
			};
			return {
				toast: { type: "success", content: decision.reason },
				...(decision.pending ? { card: { type: "raw", data: buildApprovalCard(decision.pending, resolution) } } : {}),
			};
		},
	};
}
