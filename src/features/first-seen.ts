/**
 * 外部事件去重（平台重投同一事件时不重复开任务）：只在内存里，超过容量丢最早的。
 */
export function createFirstSeen(capacity = 512): (key: string) => boolean {
	const seen = new Set<string>();
	return (key) => {
		if (seen.has(key)) return false;
		seen.add(key);
		if (seen.size > capacity) seen.delete(seen.values().next().value as string);
		return true;
	};
}
