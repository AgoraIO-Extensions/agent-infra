import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { AgentConfigurationSecretDraft } from "./agent-configuration-draft.js";

type DraftField<T extends string> = {
	key: T;
	label: string;
	required?: boolean;
	type?: "password" | "text";
};

type DraftRowsProps<T extends string> = {
	fields: readonly DraftField<T>[];
	idPrefix: string;
	label: string;
	onChange: (index: number, key: T, value: string) => void;
	onRemove: (index: number) => void;
	rows: readonly Record<T, string>[];
};

function DraftRows<T extends string>({
	fields,
	idPrefix,
	label,
	onChange,
	onRemove,
	rows,
}: DraftRowsProps<T>) {
	return (
		<>
			{rows.map((row, index) => (
				<div className="grid gap-3 sm:grid-cols-3" key={`${label}-${index}`}>
					{fields.map((field) => (
						<Field key={field.key}>
							<Label
								htmlFor={`configuration-${idPrefix}-${field.key}-${index}`}
							>
								{field.label}
							</Label>
							<Input
								autoComplete={
									field.type === "password" ? "new-password" : undefined
								}
								id={`configuration-${idPrefix}-${field.key}-${index}`}
								onChange={(event) =>
									onChange(index, field.key, event.target.value)
								}
								required={field.required}
								type={field.type ?? "text"}
								value={row[field.key]}
							/>
						</Field>
					))}
					<Button
						variant="outline"
						className="self-end"
						onClick={() => onRemove(index)}
						type="button"
					>
						<Trash2Icon aria-hidden="true" data-icon="inline-start" />
						移除{label}
					</Button>
				</div>
			))}
		</>
	);
}

const secretFields = [
	{ key: "name", label: "Secret 名称", required: true },
	{
		key: "value",
		label: "新 Secret 值",
		required: true,
		type: "password",
	},
] as const;

/** 「Secrets」分区：已有 Secret 只显示状态与版本，新值只在本次提交中使用。 */
export function ConfigurationSecretsSection({
	agent,
	onChange,
	secrets,
}: {
	agent: AgentProjectionV2;
	/** 以函数式更新修改草稿中的 Secret 行。 */
	onChange: (
		update: (
			secrets: readonly AgentConfigurationSecretDraft[],
		) => readonly AgentConfigurationSecretDraft[],
	) => void;
	secrets: readonly AgentConfigurationSecretDraft[];
}) {
	const currentSecrets = agent.configuration.secrets
		.map(
			(secret) =>
				`${secret.name}（${secret.isSet ? "已设置" : "未设置"}${secret.version === null ? "" : `，版本 ${secret.version}`}）`,
		)
		.join("、");
	return (
		<FormSection title="Secrets">
			<div className="mt-4 space-y-4">
				<p className="text-muted-foreground text-sm">
					{currentSecrets || "尚未配置 Secret"}
				</p>
				<p className="text-muted-foreground text-sm">
					Secret 仅显示设置状态与版本。填写同名的新值进行替换，原值不会回显。
				</p>
				<DraftRows
					fields={secretFields}
					idPrefix="secret"
					label="Secret"
					onChange={(index, key, value) =>
						onChange((current) =>
							current.map((secret, secretIndex) =>
								secretIndex === index ? { ...secret, [key]: value } : secret,
							),
						)
					}
					onRemove={(index) =>
						onChange((current) =>
							current.filter((_, secretIndex) => secretIndex !== index),
						)
					}
					rows={secrets}
				/>
				<Button
					variant="outline"
					onClick={() =>
						onChange((current) => [...current, { name: "", value: "" }])
					}
					type="button"
				>
					<PlusIcon aria-hidden="true" data-icon="inline-start" />
					添加 Secret
				</Button>
			</div>
		</FormSection>
	);
}
