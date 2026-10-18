import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
} from "react";

const ClockContext = createContext<() => Date>(() => new Date());

/** 测试或预览用的固定时钟；生产环境不需要包裹，默认读取当前时间。 */
export function ClockProvider({
	now,
	children,
}: {
	now: () => Date;
	children: ReactNode;
}) {
	return createElement(ClockContext.Provider, { value: now }, children);
}

/** 组件读取「现在」的唯一入口，避免在组件内直接 new Date()。 */
export function useNow(): Date {
	return useContext(ClockContext)();
}
