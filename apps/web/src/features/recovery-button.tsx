import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { useRecoveryTrigger } from "@/hooks/use-recovery-focus";

type RecoveryButtonProps = Omit<
	ComponentProps<typeof Button>,
	"disabled" | "focusableWhenDisabled" | "onClick" | "ref" | "type"
> & {
	/** 按钮空闲时的名称：同一页面里区分不同的恢复操作，失败后据此把焦点还给它。 */
	recoveryKey: string;
	/** 请求进行中：保持可聚焦（aria-disabled）并忽略重复点击。 */
	busy?: boolean;
	onClick: () => void;
};

/**
 * 读取失败后的「重新登录」「重新加载…」「重新读取」按钮，以及失败时会随页头工具一起收起的
 * 页头「刷新」按钮，所有页面共用。
 * 请求中不用原生 disabled：获得焦点的按钮被禁用后，浏览器会把焦点移到 body，读屏与 Tab
 * 都从页首重来。恢复成功、按钮随失败提示卸载时，焦点移到页面 h1（useRecoveryTrigger）。
 */
export function RecoveryButton({
	recoveryKey,
	busy = false,
	onClick,
	...props
}: RecoveryButtonProps) {
	const trigger = useRecoveryTrigger(recoveryKey);
	return (
		<Button
			{...props}
			ref={trigger.ref}
			type="button"
			disabled={busy}
			focusableWhenDisabled
			onClick={() => {
				trigger.arm();
				onClick();
			}}
		/>
	);
}
