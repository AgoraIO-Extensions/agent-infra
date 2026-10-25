import { useContext, useState } from "react";
import type { BrowserSessionState } from "./browser-session.js";
import {
	BrowserSessionQueryContext,
	markSessionRecheck,
} from "./use-browser-session.js";

/**
 * 读取返回 401 时的「重新登录」：经壳层重新确认浏览器会话，不整页刷新。会话已失效时
 * 壳层换成登录入口；会话仍有效时调用 onStillValid，把失败的读取重做一次。
 * recheck 的结果同样表示会话是否仍有效，页面自己持有读取时据此重读（个人 Relay Key）。
 * 只读取壳层已有的会话缓存，不另挂会话观察者（避免进入页面就多读一次会话）。
 */
export function useSessionRecheck(onStillValid?: () => void) {
	const sessionClient = useContext(BrowserSessionQueryContext);
	const [checking, setChecking] = useState(false);
	return {
		checking,
		recheck: async (): Promise<boolean> => {
			if (!sessionClient || checking) return false;
			setChecking(true);
			try {
				// 用户发起的确认：仍确认不了时壳层显示「暂时无法确认登录状态」（#3387）。
				markSessionRecheck(sessionClient);
				await sessionClient.refetchQueries({
					queryKey: ["browser-session"],
					exact: true,
				});
				const current = sessionClient.getQueryState<BrowserSessionState>([
					"browser-session",
				]);
				const valid =
					current?.status === "success" && current.data?.kind === "ready";
				if (valid) onStillValid?.();
				return valid;
			} finally {
				setChecking(false);
			}
		},
	};
}
