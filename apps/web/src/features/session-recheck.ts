import { useContext, useState } from "react";
import type { BrowserSessionState } from "./browser-session.js";
import { BrowserSessionQueryContext } from "./use-browser-session.js";

/**
 * 读取返回 401 时的「重新登录」：经壳层重新确认浏览器会话，不整页刷新。会话已失效时
 * 壳层换成登录入口；会话仍有效时调用 onStillValid，把失败的读取重做一次。
 * 只读取壳层已有的会话缓存，不另挂会话观察者（避免进入页面就多读一次会话）。
 */
export function useSessionRecheck(onStillValid: () => void) {
	const sessionClient = useContext(BrowserSessionQueryContext);
	const [checking, setChecking] = useState(false);
	return {
		checking,
		recheck: async () => {
			if (!sessionClient || checking) return;
			setChecking(true);
			try {
				await sessionClient.refetchQueries({
					queryKey: ["browser-session"],
					exact: true,
				});
				const current = sessionClient.getQueryState<BrowserSessionState>([
					"browser-session",
				]);
				if (current?.status === "success" && current.data?.kind === "ready")
					onStillValid();
			} finally {
				setChecking(false);
			}
		},
	};
}
