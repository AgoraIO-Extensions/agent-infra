import { Bot, ChevronDown, RefreshCw, Settings } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import { RecoveryButton } from "../recovery-button.js";
import type {
	ModelAutosavePhase,
	ModelSelectionValue,
} from "./use-conversation-model-autosave.js";

export type ComposerModelOption = Readonly<{
	optionId: string;
	displayName: string;
	reasoningLevels: readonly string[];
}>;

export type ComposerModelControlsProps = {
	options: readonly ComposerModelOption[];
	modelId: string;
	reasoning: string;
	/** 只在会话不可用、读取未就绪等阻塞状态禁用；保存中不禁用已聚焦的触发器（CK-05）。 */
	disabled: boolean;
	phase: ModelAutosavePhase;
	saved: boolean;
	onChoose: (value: ModelSelectionValue) => void;
	onRetry: () => void;
};

const removedOption = "当前选项已移除";

/**
 * 设计 #chat-settings：输入框工具栏内的轻量入口，选中即自动保存。
 * composer 宽 ≤440 时进入紧凑态：只保留一个「{模型} · {档位}」入口，菜单内分两组。
 */
export function ComposerModelControls({
	options,
	modelId,
	reasoning,
	disabled,
	phase,
	saved,
	compact,
	onChoose,
	onRetry,
}: ComposerModelControlsProps & { compact: boolean }) {
	const controls = useRef<HTMLDivElement>(null);
	const option = options.find((item) => item.optionId === modelId);
	const modelName =
		option?.displayName ?? (modelId ? removedOption : "请选择模型");
	const levels = option?.reasoningLevels ?? [];
	const level = reasoning ? reasoningLevelLabel(reasoning) : "未设置";
	function chooseModel(value: string) {
		const next = options.find((item) => item.optionId === value);
		if (!next || value === modelId) return;
		// 换模型时，当前档位仍可用就保留，否则取新模型的第一档。
		const nextReasoning = next.reasoningLevels.includes(reasoning)
			? reasoning
			: (next.reasoningLevels[0] ?? "");
		onChoose({ modelOptionId: value, reasoningLevel: nextReasoning });
	}
	function chooseReasoning(value: string) {
		if (!option || value === reasoning || !levels.includes(value)) return;
		onChoose({ modelOptionId: option.optionId, reasoningLevel: value });
	}
	const modelGroup = (
		<DropdownMenuGroup>
			<DropdownMenuLabel>模型</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={modelId}
				onValueChange={(value: string) => chooseModel(value)}
			>
				{options.map((item) => (
					<DropdownMenuRadioItem key={item.optionId} value={item.optionId}>
						{item.displayName}
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
		</DropdownMenuGroup>
	);
	const reasoningGroup = (
		<DropdownMenuGroup>
			<DropdownMenuLabel>思考强度</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={reasoning}
				onValueChange={(value: string) => chooseReasoning(value)}
			>
				{levels.map((value) => (
					<DropdownMenuRadioItem key={value} value={value}>
						{reasoningLevelLabel(value)}
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
		</DropdownMenuGroup>
	);
	return (
		<div
			ref={controls}
			className="composer-model-controls"
			data-compact={compact ? "true" : "false"}
		>
			<DropdownMenu>
				<DropdownMenuTrigger
					className="composer-setting-trigger"
					disabled={disabled}
					aria-label={`选择模型，当前 ${modelName}，思考${level}，下一条消息生效`}
					title={`${modelName} · 思考${level} · 下一条消息生效`}
				>
					<span className="control-face">
						{!compact && <Bot aria-hidden="true" className="control-glyph" />}
						<span className="control-value">{modelName}</span>
						{compact && <span className="compact-thinking">· {level}</span>}
						{!compact && (
							<ChevronDown aria-hidden="true" className="control-caret" />
						)}
					</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					aria-label="模型与思考设置"
					className={compact ? "w-[260px]" : "w-[240px]"}
				>
					{modelGroup}
					{compact && levels.length > 0 && (
						<>
							<DropdownMenuSeparator />
							{reasoningGroup}
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{!compact && (
				<DropdownMenu>
					<DropdownMenuTrigger
						className="composer-setting-trigger"
						disabled={disabled || levels.length === 0}
						aria-label={`选择思考强度，当前${level}`}
						title={`思考强度：${level} · 下一条消息生效`}
					>
						{/* 齿轮与 Agent 详情「Owner 配置」同一字形（设计 icon('settings')，G4-06）。 */}
						<span className="control-face">
							<Settings aria-hidden="true" className="control-glyph" />
							<span className="control-value">{level}</span>
							<ChevronDown aria-hidden="true" className="control-caret" />
						</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent aria-label="选择思考强度" className="w-[192px]">
						{reasoningGroup}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{phase === "saving" ? (
				<span
					className="model-preference-status"
					role="status"
					aria-label="模型设置保存中"
				>
					<Spinner size="sm" />
				</span>
			) : phase === "error" ? (
				// 重试开始即换成保存中的 spinner、按钮卸载：焦点交给模型入口（保存中不禁用），仍失败时
				// 回到按钮（RecoveryButton，#3269 N8-3-02）。
				<RecoveryButton
					variant="ghost"
					className="model-preference-retry"
					recoveryKey="设置未保存，点击重试"
					recoveryTarget={() =>
						controls.current?.querySelector<HTMLElement>(
							".composer-setting-trigger:not(:disabled)",
						) ?? null
					}
					aria-label="设置未保存，点击重试"
					title="设置未保存，点击重试"
					onClick={onRetry}
				>
					<RefreshCw aria-hidden="true" />
					重试
				</RecoveryButton>
			) : (
				<span className="sr-only" role="status">
					{saved ? "设置已保存，对下一条消息生效" : ""}
				</span>
			)}
		</div>
	);
}
