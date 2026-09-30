/**
 * 全部可选能力（登记顺序即 `status.json` 里 `features` 的顺序）。
 */
import { accessRequestFeature } from "./access-request.js";
import { alertsFeature } from "./alerts.js";
import { cardToolFeature } from "./card-tool.js";
import { cronFeature } from "./cron.js";
import { directBashFeature } from "./direct-bash.js";
import { docCommentsFeature } from "./doc-comments.js";
import { docToolsFeature } from "./doc-tools.js";
import { longReplyFeature } from "./long-reply.js";
import { retentionFeature } from "./retention.js";
import { meetingInviteFeature } from "./meeting-invite.js";
import type { BridgeFeature } from "./feature.js";
import { sttFeature } from "./stt.js";

export const FEATURES: readonly BridgeFeature[] = [cronFeature, alertsFeature, sttFeature, docCommentsFeature, meetingInviteFeature, cardToolFeature, docToolsFeature, directBashFeature, longReplyFeature, retentionFeature, accessRequestFeature];
