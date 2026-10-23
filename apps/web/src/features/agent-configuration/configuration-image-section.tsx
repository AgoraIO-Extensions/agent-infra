import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentSourceReferenceLabel } from "../agent-management-status.js";

/**
 * 自定义 Agent 的「镜像升级」分区：独立的生命周期命令，不经过配置保存。
 * 受理后只提示「已提交」，不从受理响应推断 Agent 状态（NW-16）。
 */
export function ConfigurationImageSection({
	agent,
	disabled,
	onUpgradeImage,
	submitting,
}: {
	agent: AgentProjectionV2;
	disabled: boolean;
	/** 返回 true 表示服务端已受理。 */
	onUpgradeImage: (imageReference: string) => Promise<boolean> | undefined;
	submitting: boolean;
}) {
	const toast = useToast();
	const [imageReference, setImageReference] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [focusInput, setFocusInput] = useState(false);
	const upgrade = () => {
		const reference = imageReference.trim();
		if (!reference) return;
		void Promise.resolve(onUpgradeImage(reference)).then((accepted) => {
			if (!accepted) return;
			setImageReference("");
			setFocusInput(true);
			toast("已提交镜像升级请求");
		});
	};
	// 升级进行中「升级镜像」是可聚焦的禁用，焦点留在按钮上；受理后输入框清空、按钮随之禁用，
	// 焦点交给「新镜像引用」（D2-59、#3242 K7-02）。未受理时按钮恢复可用，焦点仍在按钮上。
	useEffect(() => {
		if (!focusInput || submitting || disabled) return;
		setFocusInput(false);
		const active = document.activeElement;
		if (!active || active === document.body || active === buttonRef.current)
			inputRef.current?.focus();
	}, [focusInput, submitting, disabled]);
	return (
		<FormSection title="镜像升级">
			<p className="mt-4 text-muted-foreground text-sm">
				当前来源：{agentSourceReferenceLabel(agent)}
			</p>
			<div className="mt-4 flex flex-col gap-3 sm:flex-row">
				<Field className="flex-1">
					<Label htmlFor="configuration-image-reference">新镜像引用</Label>
					<Input
						ref={inputRef}
						disabled={disabled}
						id="configuration-image-reference"
						onChange={(event) => setImageReference(event.target.value)}
						// 分区在整页表单内：Enter 不触发整页保存，也不代为升级。
						onKeyDown={(event) => {
							if (event.key === "Enter") event.preventDefault();
						}}
						value={imageReference}
					/>
				</Field>
				<Button
					ref={buttonRef}
					variant="outline"
					className="self-end"
					disabled={disabled || imageReference.trim().length === 0}
					focusableWhenDisabled={submitting}
					onClick={upgrade}
					type="button"
				>
					{submitting ? "升级中…" : "升级镜像"}
				</Button>
			</div>
		</FormSection>
	);
}
