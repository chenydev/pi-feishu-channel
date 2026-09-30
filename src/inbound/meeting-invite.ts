/**
 * 会议邀请（vc.bot.meeting_invited_v1）→ 在邀请人私聊里开一轮任务（对齐 hermes feishu_meeting_invite.py）。
 *
 * 桥本身不会入会；任务交给 agent（容器里有 lark-cli 与会议相关技能时可以尝试入会，否则向邀请人说明原因）。
 * 回复走邀请人的私聊，因此邀请人必须通过私聊准入（管理员 / allowUsers）。
 */

export interface MeetingInvite {
	eventId?: string;
	meetingId: string;
	meetingNo: string;
	topic?: string;
	inviterOpenId: string;
	inviterName?: string;
	hostName?: string;
	/** 毫秒时间戳。 */
	startTime?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object") return value as Record<string, unknown>;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}
	return {};
}

function str(value: unknown): string | undefined {
	if (typeof value === "number") return String(value);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 有的推送把业务体包在 body.content[].data 里（application/json），先拆包（hermes `_content_payload`）。 */
function contentPayload(container: Record<string, unknown>): Record<string, unknown> {
	const content = asRecord(container.body).content;
	if (!Array.isArray(content)) return {};
	for (const raw of content) {
		const item = asRecord(raw);
		const type = String(item.contentType ?? item.content_type ?? "").toLowerCase();
		if (type && type !== "application/json") continue;
		for (const key of ["data", "value", "content", "json"]) {
			const payload = asRecord(item[key]);
			if (Object.keys(payload).length > 0) return payload;
		}
	}
	return {};
}

export function parseMeetingInvite(data: unknown): MeetingInvite | undefined {
	const root = asRecord(data);
	let event = asRecord(root.event);
	if (Object.keys(event).length === 0) event = root;
	event = { ...event, ...contentPayload(event), ...contentPayload(root) };
	const meeting = asRecord(event.meeting);
	const inviter = asRecord(event.inviter);
	const inviterOpenId = str(asRecord(inviter.id).open_id);
	const meetingNo = str(meeting.meeting_no);
	if (!inviterOpenId || !meetingNo) return undefined;
	const startTime = Number(str(meeting.start_time));
	const eventId = str(event.event_id) ?? str(asRecord(root.header).event_id);
	return {
		...(eventId ? { eventId } : {}),
		meetingId: str(meeting.id) ?? meetingNo,
		meetingNo,
		...(str(meeting.topic) ? { topic: str(meeting.topic) } : {}),
		inviterOpenId,
		...(str(inviter.user_name) ? { inviterName: str(inviter.user_name) } : {}),
		...(str(asRecord(meeting.host_user).user_name) ? { hostName: str(asRecord(meeting.host_user).user_name) } : {}),
		...(Number.isFinite(startTime) && startTime > 0 ? { startTime: startTime < 1e12 ? startTime * 1000 : startTime } : {}),
	};
}

/** 去重键：同一邀请的重投不重复开任务。 */
export function meetingInviteKey(invite: MeetingInvite): string {
	return invite.eventId ? `vc_invite:${invite.eventId}` : `vc_invite:${invite.meetingId}:${invite.inviterOpenId}`;
}

export function buildMeetingInvitePrompt(invite: MeetingInvite, formatTime?: (ms: number) => string): string {
	return [
		`[会议邀请：${invite.inviterName ?? "有人"}邀请你加入会议「${invite.topic ?? invite.meetingNo}」]`,
		`会议号：${invite.meetingNo}`,
		`主题：${invite.topic ?? "未知"}`,
		`邀请人：${invite.inviterName ?? invite.inviterOpenId}`,
		`主持人：${invite.hostName ?? "未知"}`,
		...(invite.startTime ? [`开始时间：${formatTime ? formatTime(invite.startTime) : new Date(invite.startTime).toISOString()}`] : []),
		"",
		"如果你有可用的飞书会议工具或技能（例如 lark-cli 的会议相关命令），直接尝试入会，不必再征求确认；",
		"做不到的话，用一两句话告诉邀请人原因（例如缺少会议能力或权限）。",
	].join("\n");
}
