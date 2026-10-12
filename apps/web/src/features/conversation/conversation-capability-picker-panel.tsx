import { ListFilter, RotateCcw } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	type ConversationCapabilityPickerStateV1,
	type ConversationCapabilityV1,
	confirmConversationCapability,
	createConversationCapabilityPickerState,
	filterConversationCapabilities,
	markConversationCapabilityConfirmed,
	moveConversationCapabilitySelection,
	reconcileConversationCapabilitySelection,
	resetConversationCapabilityScope,
	selectConversationCapability,
	updateConversationCapabilityParameter,
	updateConversationCapabilityQuery,
} from "./conversation-capability-picker.js";

export function ConversationCapabilityPickerPanel({
	capabilities,
	scopeKey,
	disabled,
}: {
	capabilities: readonly ConversationCapabilityV1[];
	scopeKey: string;
	disabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<ConversationCapabilityPickerStateV1>(() =>
		createConversationCapabilityPickerState(scopeKey),
	);
	const scopedState = reconcileConversationCapabilitySelection(
		resetConversationCapabilityScope(state, scopeKey),
		capabilities,
	);
	useEffect(() => {
		if (scopedState !== state) setState(scopedState);
	}, [scopedState, state]);
	const filtered = useMemo(
		() => filterConversationCapabilities(capabilities, scopedState.query),
		[capabilities, scopedState.query],
	);
	const selected = scopedState.selected;
	const confirmed = scopedState.confirmed;
	function update(next: ConversationCapabilityPickerStateV1) {
		setState(next);
	}
	function onQuery(value: string) {
		update(updateConversationCapabilityQuery(scopedState, value));
	}
	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			update(
				moveConversationCapabilitySelection(
					scopedState,
					capabilities,
					event.key === "ArrowDown" ? 1 : -1,
				),
			);
		} else if (event.key === "Enter" && filtered[scopedState.selectedIndex]) {
			event.preventDefault();
			update(
				selectConversationCapability(
					scopedState,
					filtered[scopedState.selectedIndex],
				),
			);
		}
	}
	function reset() {
		update(createConversationCapabilityPickerState(scopeKey));
	}
	if (capabilities.length === 0) return null;
	return (
		<section
			className="mb-5 rounded-[14px] border bg-card p-4"
			aria-label="对话能力"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<ListFilter className="size-4" aria-hidden="true" />
					<h2 className="font-medium">选择命令或 Skill</h2>
					<Badge variant="outline">{capabilities.length} 项</Badge>
				</div>
				<Button
					type="button"
					variant="ghost"
					disabled={disabled}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				>
					{open ? "收起" : "打开"}
				</Button>
			</div>
			{open && (
				<div className="mt-4 space-y-3">
					<Input
						value={scopedState.query}
						aria-label="搜索命令或 Skill"
						placeholder="输入名称、说明或来源"
						disabled={disabled}
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={onKeyDown}
					/>
					<div className="grid gap-2">
						{filtered.length === 0 ? (
							<p className="text-muted-foreground text-sm">没有匹配的能力。</p>
						) : (
							filtered.map((capability, index) => (
								<Button
									variant="ghost"
									type="button"
									aria-pressed={selected?.name === capability.name}
									key={`${capability.kind}:${capability.name}`}
									className={`min-h-11 rounded-[10px] border px-3 py-2 text-left ${index === scopedState.selectedIndex ? "border-primary bg-muted" : "border-border"}`}
									disabled={disabled}
									onClick={() =>
										update(
											selectConversationCapability(scopedState, capability),
										)
									}
								>
									<span className="flex items-center justify-between gap-2">
										<strong className="break-all">{capability.name}</strong>
										<Badge variant="secondary">{capability.kind}</Badge>
									</span>
									<span className="mt-1 block text-muted-foreground text-sm">
										{capability.description}
									</span>
									<span className="mt-1 block text-muted-foreground text-xs">
										{capability.source}
										{capability.version ? ` · ${capability.version}` : ""}
									</span>
								</Button>
							))
						)}
					</div>
					{selected && (
						<div className="space-y-3 rounded-[10px] border border-dashed p-3">
							<p className="font-medium">{selected.name} 参数</p>
							<Input
								value={scopedState.parameterText}
								aria-label="能力参数"
								placeholder={selected.parameterHint ?? "可选参数"}
								disabled={disabled}
								onChange={(event) =>
									update(
										updateConversationCapabilityParameter(
											scopedState,
											event.target.value,
										),
									)
								}
							/>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									disabled={
										disabled ||
										confirmConversationCapability(scopedState) === undefined
									}
									onClick={() =>
										update(markConversationCapabilityConfirmed(scopedState))
									}
								>
									确认选择
								</Button>
								<Button type="button" variant="ghost" onClick={reset}>
									<RotateCcw aria-hidden="true" />
									清除
								</Button>
							</div>
						</div>
					)}
					{confirmed && (
						<Alert>
							<AlertDescription>
								选择已保存在当前草稿中；执行接缝尚未接入，未提交请求。
							</AlertDescription>
						</Alert>
					)}
				</div>
			)}
		</section>
	);
}
