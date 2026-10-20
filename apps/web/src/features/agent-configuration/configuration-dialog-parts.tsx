import { XIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * 只写密码框：非受控（不传 value / defaultValue），明文不进入 React state、草稿或 DOM 的
 * value 属性；调用方只在提交时经 ref 读取，关闭或成功后清空（NI-02）。基础层 Input 在
 * 没有 Field.Root 时不托管输入值。
 */
export function WriteOnlyPasswordInput(
	props: Omit<
		React.ComponentProps<typeof Input>,
		"type" | "value" | "defaultValue" | "autoComplete" | "onChange"
	>,
) {
	return (
		<Input
			{...props}
			type="password"
			autoComplete="new-password"
			spellCheck={false}
		/>
	);
}

/**
 * 与基础层 DialogHeader 相同的标题行，但关闭钮可在请求进行中禁用（NI-95）。
 * 使用时 DialogContent 传 showCloseButton={false}。
 */
export function ConfigurationDialogHeader({
	title,
	closeDisabled,
}: {
	title: React.ReactNode;
	closeDisabled: boolean;
}) {
	return (
		<div
			data-slot="dialog-header"
			className="flex items-start justify-between gap-4"
		>
			<div className="min-w-0 flex-1">
				<DialogTitle>{title}</DialogTitle>
			</div>
			<DialogClose
				data-slot="dialog-close"
				// 与基础层 DialogHeader 的图标关闭钮同名，避免与页脚文字按钮重名（X-04）。
				aria-label="关闭弹窗"
				disabled={closeDisabled}
				render={<Button variant="ghost" size="icon" className="shrink-0" />}
			>
				<XIcon aria-hidden="true" className="size-[18px]" />
			</DialogClose>
		</div>
	);
}
