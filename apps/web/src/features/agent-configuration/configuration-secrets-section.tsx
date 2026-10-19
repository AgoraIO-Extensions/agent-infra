import { KeyRoundIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { AgentConfigurationEnvironmentDraft } from "./agent-configuration-draft.js";
import {
	type SecretDialogTarget,
	SecretReplaceDialog,
} from "./secret-replace-dialog.js";

type ConfigurationSecretsSectionProps = {
	agent: AgentProjectionV2;
	/** 标准模板开放的环境变量键；undefined 表示名称自由输入（自定义 Agent 或模板未读取）。 */
	allowedEnvironmentKeys?: readonly string[];
	/** 标准模板开放的 Secret 键；undefined 表示名称自由输入。 */
	allowedSecretKeys?: readonly string[];
	disabled: boolean;
	environment: readonly AgentConfigurationEnvironmentDraft[];
	/** 每行环境变量的字段错误（由整页保存校验给出）。 */
	environmentErrors: Readonly<Record<number, string>>;
	onEnvironmentChange: (
		update: (
			rows: readonly AgentConfigurationEnvironmentDraft[],
		) => readonly AgentConfigurationEnvironmentDraft[],
	) => void;
	/** 替换或添加单个 Secret 的独立请求；未提供时不显示替换入口。 */
	onReplaceSecret?: (name: string, value: string) => Promise<AgentProjectionV2>;
};

export function secretStatusText(secret: {
	readonly isSet: boolean;
	readonly version: number | null;
}) {
	if (!secret.isSet) return "未设置";
	return secret.version === null
		? "已设置"
		: `已设置 · version ${secret.version}`;
}

/**
 * 「环境变量与 Secret」分区（O-10）：环境变量可编辑并随整页保存；Secret 只读显示名称与
 * 状态，替换走只写弹窗的独立请求，不进入页面草稿。
 */
export function ConfigurationSecretsSection({
	agent,
	allowedEnvironmentKeys,
	allowedSecretKeys,
	disabled,
	environment,
	environmentErrors,
	onEnvironmentChange,
	onReplaceSecret,
}: ConfigurationSecretsSectionProps) {
	const toast = useToast();
	const [dialogTarget, setDialogTarget] = useState<SecretDialogTarget | null>(
		null,
	);
	const triggerRef = useRef<HTMLElement | null>(null);
	const secrets = agent.configuration.secrets;
	const existingNames = secrets.map((secret) => secret.name);
	const addableSecretKeys = allowedSecretKeys?.filter(
		(key) => !existingNames.includes(key),
	);
	const canAddSecret =
		onReplaceSecret !== undefined &&
		(addableSecretKeys === undefined || addableSecretKeys.length > 0);
	const openDialog = (target: SecretDialogTarget, trigger: HTMLElement) => {
		triggerRef.current = trigger;
		setDialogTarget(target);
	};

	return (
		<FormSection
			title="环境变量与 Secret"
			description="Secret 只显示名称、版本和状态；替换后生成新版本。"
		>
			<div className="configuration-environment-rows">
				{environment.map((entry, index) => {
					const nameId = `configuration-environment-name-${index}`;
					const valueId = `configuration-environment-value-${index}`;
					const errorId = `configuration-environment-error-${index}`;
					const error = environmentErrors[index];
					const nameOptions = allowedEnvironmentKeys
						? [
								...new Set([
									...allowedEnvironmentKeys,
									...(entry.name ? [entry.name] : []),
								]),
							]
						: undefined;
					const rowLabel = entry.name.trim() || `第 ${index + 1} 行`;
					return (
						<div className="configuration-field-row" key={index}>
							<Field>
								<Label htmlFor={nameId}>环境变量名</Label>
								{nameOptions ? (
									<NativeSelect
										id={nameId}
										disabled={disabled}
										value={entry.name}
										aria-invalid={error ? "true" : undefined}
										aria-describedby={error ? errorId : undefined}
										onChange={(event) =>
											onEnvironmentChange((rows) =>
												rows.map((row, rowIndex) =>
													rowIndex === index
														? { ...row, name: event.target.value }
														: row,
												),
											)
										}
									>
										<NativeSelectOption value="">请选择</NativeSelectOption>
										{nameOptions.map((key) => (
											<NativeSelectOption key={key} value={key}>
												{key}
											</NativeSelectOption>
										))}
									</NativeSelect>
								) : (
									<Input
										id={nameId}
										disabled={disabled}
										value={entry.name}
										autoComplete="off"
										spellCheck={false}
										aria-invalid={error ? "true" : undefined}
										aria-describedby={error ? errorId : undefined}
										onChange={(event) =>
											onEnvironmentChange((rows) =>
												rows.map((row, rowIndex) =>
													rowIndex === index
														? { ...row, name: event.target.value }
														: row,
												),
											)
										}
									/>
								)}
								{error ? <FieldError id={errorId}>{error}</FieldError> : null}
							</Field>
							<Field>
								<Label htmlFor={valueId}>值</Label>
								<Input
									id={valueId}
									disabled={disabled}
									value={entry.value}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) =>
										onEnvironmentChange((rows) =>
											rows.map((row, rowIndex) =>
												rowIndex === index
													? { ...row, value: event.target.value }
													: row,
											),
										)
									}
								/>
							</Field>
							<Button
								type="button"
								variant="ghost"
								disabled={disabled}
								aria-label={withObjectName("移除", rowLabel)}
								onClick={() =>
									onEnvironmentChange((rows) =>
										rows.filter((_, rowIndex) => rowIndex !== index),
									)
								}
							>
								<XIcon aria-hidden="true" data-icon="inline-start" />
								移除
							</Button>
						</div>
					);
				})}
			</div>
			<div className="configuration-section-actions">
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					onClick={() =>
						onEnvironmentChange((rows) => [...rows, { name: "", value: "" }])
					}
				>
					<PlusIcon aria-hidden="true" data-icon="inline-start" />
					添加环境变量
				</Button>
			</div>
			<div className="configuration-secret-rows">
				{secrets.length === 0 ? (
					<p className="text-muted-foreground text-sm">尚未配置 Secret。</p>
				) : null}
				{secrets.map((secret, index) => {
					const nameId = `configuration-secret-name-${index}`;
					const statusId = `configuration-secret-status-${index}`;
					return (
						<div className="configuration-field-row" key={secret.name}>
							<Field>
								<Label htmlFor={nameId}>Secret 名称</Label>
								<Input id={nameId} readOnly value={secret.name} />
							</Field>
							<Field>
								<Label htmlFor={statusId}>当前状态</Label>
								<Input
									id={statusId}
									readOnly
									value={secretStatusText(secret)}
								/>
							</Field>
							{onReplaceSecret ? (
								<Button
									type="button"
									variant="outline"
									disabled={disabled}
									aria-label={withObjectName("替换 Secret", secret.name)}
									onClick={(event) =>
										openDialog(
											{ mode: "replace", name: secret.name },
											event.currentTarget,
										)
									}
								>
									<KeyRoundIcon aria-hidden="true" data-icon="inline-start" />
									替换 Secret
								</Button>
							) : null}
						</div>
					);
				})}
			</div>
			{canAddSecret ? (
				<div className="configuration-section-actions">
					<Button
						type="button"
						variant="outline"
						disabled={disabled}
						onClick={(event) =>
							openDialog({ mode: "add" }, event.currentTarget)
						}
					>
						<PlusIcon aria-hidden="true" data-icon="inline-start" />
						添加 Secret
					</Button>
				</div>
			) : null}
			{onReplaceSecret ? (
				<SecretReplaceDialog
					target={dialogTarget}
					allowedNames={allowedSecretKeys}
					existingNames={existingNames}
					finalFocus={triggerRef}
					onClose={() => setDialogTarget(null)}
					onSubmit={onReplaceSecret}
					onSaved={(_name, version) =>
						toast(
							version === null
								? "Secret 已写入，等待 Worker 激活"
								: `Secret 已写入 pending version ${version}，等待 Worker 激活`,
						)
					}
				/>
			) : null}
		</FormSection>
	);
}
