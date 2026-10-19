import { type RefObject, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type AgentConfigurationRequestError,
	type AgentDefaultRelayKeyCheck,
	isRetryableConfigurationError,
} from "./agent-configuration.js";
import {
	ConfigurationDialogHeader,
	WriteOnlyPasswordInput,
} from "./configuration-dialog-parts.js";
import {
	ConfigurationModelPicker,
	type ConfigurationModelPickerChange,
} from "./configuration-model-picker.js";
import {
	currentOptionLabel,
	type KeylessCurrentModelOption,
	type KeylessEndpointNames,
	type KeylessModelSelection,
	uncoveredCurrentOptions,
} from "./keyless-model-selection.js";

export type DefaultRelayKeyReplacement = {
	readonly keyValue: string;
	readonly configurationRevision: number;
	readonly expectedVersion: number | null;
};

type DefaultRelayKeyDialogProps = {
	open: boolean;
	current: readonly KeylessCurrentModelOption[];
	currentDefault: { optionId: string; level: string };
	endpointNames?: KeylessEndpointNames;
	finalFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
	/** 检查新 Key 可见的模型（不写入）。 */
	onCheck: (keyValue: string) => Promise<AgentDefaultRelayKeyCheck>;
	/** 新候选覆盖当前全部模型：关闭弹窗，由分区显示「校验中」并只替换 Key。 */
	onCovered: (replacement: DefaultRelayKeyReplacement) => void;
	/** 新候选不覆盖当前模型：Key 与模型集合一次提交，只带这几项（G-09）。 */
	onReplaceWithModels: (
		body: AgentConfigurationUpdateRequestV2Writable,
	) => Promise<AgentProjectionV2>;
	/** 带模型的替换成功（页面给 Toast 并回焦）。 */
	onReplacedWithModels: () => void;
};

type Checked = AgentDefaultRelayKeyCheck & { readonly uncovered: string[] };

export function defaultRelayKeyFailureText(
	error: AgentConfigurationRequestError | null,
) {
	return isRetryableConfigurationError(error)
		? "暂时无法完成校验，原版本与可用模型保持不变，请重试。"
		: "这个 Key 不能用于当前 Agent，或默认 Key、配置已更新；原版本保持不变，请检查 Key 或刷新页面后重试。";
}

/**
 * 「替换 Agent 默认 Relay Key」弹窗（G-09）：只写密码框，「校验并替换」先在弹窗内检查
 * 新 Key 的可用模型。覆盖当前模型时交给分区写入；不覆盖时在弹窗内列出受影响的模型并
 * 展开新候选，确认后 Key 与模型一次提交，不带页面上的其他草稿。
 */
export function DefaultRelayKeyDialog({
	open,
	current,
	currentDefault,
	endpointNames,
	finalFocus,
	onClose,
	onCheck,
	onCovered,
	onReplaceWithModels,
	onReplacedWithModels,
}: DefaultRelayKeyDialogProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [phase, setPhase] = useState<"input" | "checking" | "saving">("input");
	const [fieldError, setFieldError] = useState<string>();
	const [failure, setFailure] = useState<AgentConfigurationRequestError | null>(
		null,
	);
	const [checked, setChecked] = useState<Checked>();
	const [selection, setSelection] = useState<KeylessModelSelection | null>(
		null,
	);
	const generation = useRef(0);
	const busy = phase !== "input";

	useEffect(() => {
		if (!open) return;
		generation.current += 1;
		setPhase("input");
		setFieldError(undefined);
		setFailure(null);
		setChecked(undefined);
		setSelection(null);
		return () => {
			generation.current += 1;
			if (inputRef.current) inputRef.current.value = "";
		};
	}, [open]);

	useEffect(() => {
		if (failure) inputRef.current?.focus();
	}, [failure]);

	const submit = async () => {
		if (busy) return;
		const keyValue = inputRef.current?.value.trim() ?? "";
		if (!keyValue) {
			setFieldError("请输入默认 Relay Key。");
			inputRef.current?.focus();
			return;
		}
		setFieldError(undefined);
		setFailure(null);
		// 已检查且需要重新选择模型：Key 与模型一次提交。
		if (checked && checked.uncovered.length > 0) {
			if (!selection) return;
			setPhase("saving");
			const mine = ++generation.current;
			try {
				await onReplaceWithModels({
					schemaVersion: 2,
					defaultRelayKey: keyValue,
					modelConfiguration: selection,
					expectedConfigurationRevision: checked.configurationRevision,
					expectedKeyVersion: checked.keyVersion,
				});
				if (mine !== generation.current) return;
				if (inputRef.current) inputRef.current.value = "";
				setPhase("input");
				onClose();
				onReplacedWithModels();
			} catch (error) {
				if (mine !== generation.current) return;
				setPhase("input");
				setFailure(error as AgentConfigurationRequestError);
			}
			return;
		}
		setPhase("checking");
		const mine = ++generation.current;
		try {
			const result = await onCheck(keyValue);
			if (mine !== generation.current) return;
			const uncovered = uncoveredCurrentOptions(result.candidates, current);
			if (uncovered.length === 0) {
				if (inputRef.current) inputRef.current.value = "";
				setPhase("input");
				onClose();
				onCovered({
					keyValue,
					configurationRevision: result.configurationRevision,
					expectedVersion: result.keyVersion,
				});
				return;
			}
			setChecked({
				...result,
				uncovered: uncovered.map((option) =>
					currentOptionLabel(option, endpointNames),
				),
			});
			setPhase("input");
		} catch (error) {
			if (mine !== generation.current) return;
			setPhase("input");
			setFailure(error as AgentConfigurationRequestError);
		}
	};

	const needsSelection = checked !== undefined && checked.uncovered.length > 0;
	const noCandidates = needsSelection && checked.candidates.length === 0;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onClose();
			}}
		>
			<DialogContent
				showCloseButton={false}
				initialFocus={inputRef}
				finalFocus={finalFocus}
			>
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						// 弹窗经 Portal 渲染，React 事件仍会冒泡到页面表单：不能触发整页保存（NI-71）。
						event.stopPropagation();
						void submit();
					}}
				>
					<ConfigurationDialogHeader
						title="替换 Agent 默认 Relay Key"
						closeDisabled={busy}
					/>
					<DialogBody className="space-y-[15px]">
						<Field>
							<Label htmlFor="replace-default-relay-key-input">
								新的 Relay Key
							</Label>
							<WriteOnlyPasswordInput
								ref={inputRef}
								id="replace-default-relay-key-input"
								name="default-relay-key"
								placeholder="仅本次提交使用，不会回显"
								readOnly={busy}
								aria-invalid={fieldError ? "true" : undefined}
								aria-describedby={
									fieldError ? "replace-default-relay-key-error" : undefined
								}
								onInput={() => {
									// Key 改动后，之前的检查结果不能套在新 Key 上。
									generation.current += 1;
									setFieldError(undefined);
									setChecked(undefined);
									setSelection(null);
								}}
							/>
							{fieldError ? (
								<FieldError id="replace-default-relay-key-error">
									{fieldError}
								</FieldError>
							) : null}
						</Field>
						{needsSelection ? (
							<Alert tone="warn" role="status">
								<AlertTitle>
									{noCandidates
										? "新的 Key 没有此模板可用的模型"
										: "新的 Key 不能调用部分当前模型"}
								</AlertTitle>
								<AlertDescription>
									{noCandidates
										? "默认 Key 未替换；请换一个 Key 后重新校验。"
										: `${checked.uncovered.join("、")}。请在下方重新选择模型，确认后 Key 与模型一起替换。`}
								</AlertDescription>
							</Alert>
						) : null}
						{needsSelection && !noCandidates ? (
							<ConfigurationModelPicker
								candidates={checked.candidates}
								current={current}
								currentDefault={currentDefault}
								description="只列出新 Key 可见、且模板支持的模型。"
								disabled={busy}
								endpointNames={endpointNames}
								idPrefix="replace-default-relay-key-model"
								onChange={({
									selection: next,
								}: ConfigurationModelPickerChange) => setSelection(next)}
							/>
						) : null}
						{failure ? (
							<Alert tone="danger" role="alert">
								<AlertTitle>默认 Key 未替换</AlertTitle>
								<AlertDescription>
									{defaultRelayKeyFailureText(failure)}
								</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>
					<DialogFooter>
						<DialogClose disabled={busy} render={<Button variant="ghost" />}>
							取消
						</DialogClose>
						<Button
							type="submit"
							disabled={busy || (needsSelection && !selection)}
							focusableWhenDisabled
						>
							{phase === "checking"
								? "正在校验…"
								: phase === "saving"
									? "正在替换…"
									: "校验并替换"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
