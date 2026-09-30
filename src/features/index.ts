/**
 * 全部可选能力（登记顺序即 `status.json` 里 `features` 的顺序）。
 */
import { alertsFeature } from "./alerts.js";
import { cronFeature } from "./cron.js";
import type { BridgeFeature } from "./feature.js";

export const FEATURES: readonly BridgeFeature[] = [cronFeature, alertsFeature];
