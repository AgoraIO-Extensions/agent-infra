import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentSourceReferenceLabel } from "../agent-management-status.js";
import {
	type AgentConfigurationRequestError,
	isRetryableConfigurationError,
} from "./agent-configuration.js";

/**
 * 自定义 Agent 的「镜像升级」分区：独立的生命周期命令，不经过配置保存。
 * 受理后只提示「已提交」，不从受理响应推断 Agent 状态（NW-16）。进行中与失败只在本分区内
 * 呈现，不改变页脚「保存配置」的文字与整页字段（#3268 N8-2-06）。
 */
export function ConfigurationImageSection({
	agent,
	disabled,
	error,
	onUpgradeImage,
	upgrading,
}: {
	agent: AgentProjectionV2;
	/** 整页保存进行中或 Agent 已停用。 */
	disabled: boolean;
	/** 最近一次镜像升级失败。 */
	error: AgentConfigurationRequestError | null;
	/** 返回 true 表示服务端已受理。 */
	onUpgradeImage: (imageReference: string) => Promise<boolean> | undefined;
	upgrading: boolean;
}) {
	const toast = useToast();
	const [imageReference, setImageReference] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [focusInput, setFocusInput] = useState(false);
	const upgrade = () => {
		const reference = imageReference.trim();
		// 进行中按钮仍可聚焦：再次点击或按 Enter 不重复提交（提交 hook 另有同一时刻只受理一个命令的守卫）。
		if (!reference || upgrading || disabled) return;
		void Promise.resolve(onUpgradeImage(reference)).then((accepted) => {
			if (!accepted) return;
			setImageReference("");
			setFocusInput(true);
			toast("已提交镜像升级请求");
		});
	};
	// 升级进行中「升级镜像」是可聚焦的禁用，焦点留在按钮上；受理后输入框清空、按钮随之禁用，
	// 焦点交给「新镜像引用」（D2-59、#3242 K7-02）。未受理时按钮恢复可用，焦点仍在按钮上，
	// 失败说明出现在本分区内（#3268 N8-2-06）。
	useEffect(() => {
		if (!focusInput || upgrading || disabled) return;
		setFocusInput(false);
		const active = document.activeElement;
		if (!active || active === document.body || active === buttonRef.current)
			inputRef.current?.focus();
	}, [focusInput, upgrading, disabled]);
	return (
		// 「当前来源」是本分区的说明，与同页分区说明同级（13px，FormSection description）。
		<FormSection
			title="镜像升级"
			description={`当前来源：${agentSourceReferenceLabel(agent)}`}
		>
			<div className="mt-4 flex flex-col gap-3 sm:flex-row">
				<Field className="flex-1">
					<Label htmlFor="configuration-image-reference">新镜像引用</Label>
					<Input
						ref={inputRef}
						disabled={disabled || upgrading}
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
					disabled={disabled || upgrading || imageReference.trim().length === 0}
					focusableWhenDisabled={upgrading}
					onClick={upgrade}
					type="button"
				>
					{upgrading ? "升级中…" : "升级镜像"}
				</Button>
			</div>
			{error && !upgrading ? (
				<Alert tone="danger" role="alert" className="mt-4">
					<AlertDescription>
						{isRetryableConfigurationError(error)
							? "镜像升级未能提交，请重试。"
							: "权限或 Agent 状态已变化，请刷新页面。"}
					</AlertDescription>
				</Alert>
			) : null}
		</FormSection>
	);
}
