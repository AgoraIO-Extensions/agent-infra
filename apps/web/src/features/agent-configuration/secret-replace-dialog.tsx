import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { configurationKeyError } from "./agent-configuration-draft.js";
import {
	ConfigurationDialogHeader,
	WriteOnlyPasswordInput,
} from "./configuration-dialog-parts.js";

export type SecretDialogTarget =
	| { readonly mode: "replace"; readonly name: string }
	| { readonly mode: "add" };

type SecretReplaceDialogProps = {
	/** null 时弹窗关闭。 */
	target: SecretDialogTarget | null;
	/** 标准模板开放的 Secret 键；undefined 表示自定义 Agent，名称自由输入。 */
	allowedNames?: readonly string[];
	/** 已有 Secret 名称：添加时不再提供，需用「替换 Secret」。 */
	existingNames: readonly string[];
	/** 关闭后焦点回到的触发按钮。 */
	finalFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
	/** 独立请求：只提交这一个 Secret，返回服务端新投影。 */
	onSubmit: (name: string, value: string) => Promise<AgentProjectionV2>;
	/** 写入成功：页面据此给 Toast（版本取响应投影中该 Secret 的 version）。 */
	onSaved: (name: string, version: number | null) => void;
};

/**
 * 「替换 Secret」弹窗（O-10、N-08）：只写、直接保存这一个 Secret。
 * 请求中弹窗保持打开、焦点留在弹窗内；失败只在弹窗内提示（NI-13、NI-71、NI-95）。
 */
export function SecretReplaceDialog({
	target,
	allowedNames,
	existingNames,
	finalFocus,
	onClose,
	onSubmit,
	onSaved,
}: SecretReplaceDialogProps) {
	const open = target !== null;
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	const [valueError, setValueError] = useState<string>();
	const [nameError, setNameError] = useState<string>();
	const [name, setName] = useState("");
	const valueRef = useRef<HTMLInputElement>(null);
	const nameRef = useRef<HTMLElement | null>(null);
	const ids = useId();
	const valueId = `${ids}-secret-value`;
	const valueErrorId = `${ids}-secret-value-error`;
	const nameId = `${ids}-secret-name`;
	const nameErrorId = `${ids}-secret-name-error`;
	const addable = allowedNames?.filter((key) => !existingNames.includes(key));

	// 每次打开都从空白开始；关闭时清掉 DOM 中残留的输入。
	useEffect(() => {
		if (!open) return;
		setPending(false);
		setFailed(false);
		setValueError(undefined);
		setNameError(undefined);
		setName("");
		return () => {
			if (valueRef.current) valueRef.current.value = "";
		};
	}, [open]);

	// 失败后焦点回到密码框，便于直接重试（NI-95）。
	useEffect(() => {
		if (failed) valueRef.current?.focus();
	}, [failed]);

	const submit = async () => {
		if (pending || target === null) return;
		const secretName = target.mode === "replace" ? target.name : name.trim();
		if (target.mode === "add") {
			const error =
				configurationKeyError(secretName, {
					kind: "secret",
					allowedNames: addable,
				}) ??
				(existingNames.includes(secretName)
					? "这个 Secret 已存在，请使用「替换 Secret」。"
					: undefined);
			setNameError(error);
			if (error) {
				nameRef.current?.focus();
				return;
			}
		}
		const value = valueRef.current?.value ?? "";
		if (!value) {
			setValueError("请输入新的 Secret 值。");
			valueRef.current?.focus();
			return;
		}
		setValueError(undefined);
		setFailed(false);
		setPending(true);
		try {
			const projection = await onSubmit(secretName, value);
			if (valueRef.current) valueRef.current.value = "";
			const version =
				projection.configuration.secrets.find(
					(secret) => secret.name === secretName,
				)?.version ?? null;
			setPending(false);
			onClose();
			onSaved(secretName, version);
		} catch {
			setPending(false);
			setFailed(true);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// 请求进行中，取消、关闭钮、Esc 与点遮罩都不关闭弹窗（NI-95）。
				if (!next && !pending) onClose();
			}}
		>
			<DialogContent
				showCloseButton={false}
				initialFocus={target?.mode === "add" ? nameRef : valueRef}
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
						title={target?.mode === "add" ? "添加 Secret" : "替换 Secret"}
						closeDisabled={pending}
					/>
					<DialogBody>
						{target?.mode === "replace" ? (
							<p
								data-slot="secret-dialog-subject"
								className="break-words font-[650]"
							>
								{target.name}
							</p>
						) : null}
						<DialogDescription>
							输入新值后只会保存密文版本。页面不会显示当前 Secret 值。
						</DialogDescription>
						{target?.mode === "add" ? (
							<Field className="mt-[15px]">
								<Label htmlFor={nameId}>Secret 名称</Label>
								{addable ? (
									<NativeSelect
										ref={(element) => {
											nameRef.current = element;
										}}
										id={nameId}
										value={name}
										aria-invalid={nameError ? "true" : undefined}
										aria-describedby={nameError ? nameErrorId : undefined}
										onChange={(event) => {
											setName(event.target.value);
											setNameError(undefined);
										}}
									>
										<NativeSelectOption value="">
											请选择 Secret 名称
										</NativeSelectOption>
										{addable.map((key) => (
											<NativeSelectOption key={key} value={key}>
												{key}
											</NativeSelectOption>
										))}
									</NativeSelect>
								) : (
									<Input
										ref={(element: HTMLInputElement | null) => {
											nameRef.current = element;
										}}
										id={nameId}
										value={name}
										readOnly={pending}
										aria-invalid={nameError ? "true" : undefined}
										aria-describedby={nameError ? nameErrorId : undefined}
										onChange={(event) => {
											setName(event.target.value);
											setNameError(undefined);
										}}
									/>
								)}
								{nameError ? (
									<FieldError id={nameErrorId}>{nameError}</FieldError>
								) : null}
							</Field>
						) : null}
						<Field className="mt-[15px]">
							<Label htmlFor={valueId}>新 Secret 值</Label>
							<WriteOnlyPasswordInput
								ref={valueRef}
								id={valueId}
								name="secret-value"
								placeholder="仅本次提交使用"
								readOnly={pending}
								aria-invalid={valueError ? "true" : undefined}
								aria-describedby={valueError ? valueErrorId : undefined}
								onInput={() => setValueError(undefined)}
							/>
							{valueError ? (
								<FieldError id={valueErrorId}>{valueError}</FieldError>
							) : null}
						</Field>
						{failed ? (
							<Alert tone="danger" role="alert" className="mt-[15px]">
								<AlertDescription>Secret 替换未完成，请重试。</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>
					<DialogFooter>
						<DialogClose disabled={pending} render={<Button variant="ghost" />}>
							取消
						</DialogClose>
						<Button type="submit" disabled={pending} focusableWhenDisabled>
							{pending
								? "正在保存…"
								: target?.mode === "add"
									? "保存 Secret"
									: "保存替换"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
