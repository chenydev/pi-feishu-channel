/**
 * 在 `fn` 执行期间持有一个事件循环句柄。
 *
 * 生产代码里有限时等待的计时器都是 unref 的（不该拖住进程退出）。测试里被等待的往往是一个
 * 永不返回的 promise —— 它不占事件循环，于是事件循环里只剩那个 unref 的计时器。Node 20/22 的
 * 测试运行器会因此判定「事件循环已空」，直接取消当前及后续测试（Node 24 不会）。
 */
export async function holdEventLoop<T>(fn: () => Promise<T>): Promise<T> {
	const handle = setInterval(() => {}, 60_000);
	try {
		return await fn();
	} finally {
		clearInterval(handle);
	}
}
