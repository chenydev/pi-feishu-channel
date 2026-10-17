import { atomicWriteJson } from "./atomic-file.js";
import type { BridgeStatus } from "../types.js";

export function writeStatus(file: string, status: BridgeStatus): void {
	atomicWriteJson(file, status, { indent: 2 });
}
