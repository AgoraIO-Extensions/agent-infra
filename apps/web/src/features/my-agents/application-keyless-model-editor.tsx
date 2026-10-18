import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { KeylessModelPicker } from "../agent-configuration/keyless-model-picker.js";
import type { KeylessCurrentModelOption } from "../agent-configuration/keyless-model-selection.js";
import type { useKeylessKeyCheck } from "../agent-configuration/use-keyless-key-check.js";

type ApplicationKeylessModelEditorProps = {
	current: readonly KeylessCurrentModelOption[];
	currentDefault: { optionId: string; level: string };
	disabled: boolean;
	/** 表单校验或保存被拦下时的提示。 */
	error?: string | undefined;
	errorId: string;
	keyCheck: ReturnType<typeof useKeylessKeyCheck>;
	onChangeKey: () => void;
};

/**
 * 编辑由默认 Relay Key 管理模型的申请（#2421）：重新输入 Key，检查后只能从该 Key 可见的
 * 模型里选择；保存时 Key、模型集合和检查时看到的版本一起提交。
 */
export function ApplicationKeylessModelEditor({
	current,
	currentDefault,
	disabled,
	error,
	errorId,
	keyCheck,
	onChangeKey,
}: ApplicationKeylessModelEditorProps) {
	return (
		<div className="space-y-4">
			<Field>
				<Label htmlFor="application-default-relay-key">
					Agent 默认 Relay Key
				</Label>
				<div className="flex flex-wrap gap-3">
					<Input
						aria-describedby={error ? errorId : undefined}
						aria-invalid={error ? true : undefined}
						autoComplete="new-password"
						disabled={disabled}
						id="application-default-relay-key"
						onChange={(event) => {
							keyCheck.setKey(event.target.value);
							onChangeKey();
						}}
						required
						type="password"
						value={keyCheck.key}
					/>
					<Button
						disabled={disabled || keyCheck.checking || !keyCheck.typed}
						onClick={() => void keyCheck.runCheck()}
						type="button"
						variant="outline"
					>
						{keyCheck.checking ? "正在检查…" : "检查可用模型"}
					</Button>
				</div>
				<p className="text-muted-foreground text-sm">
					更换模型集合需要重新提交 Key；检查后只能从该 Key
					可见的模型里选择。保存后不会回显。
				</p>
				{keyCheck.error ? (
					<Alert variant="destructive">
						<AlertDescription>
							Key 校验失败或暂时无法读取可用模型，请检查后重试。
						</AlertDescription>
					</Alert>
				) : null}
				{error ? (
					<p className="text-destructive text-sm" id={errorId}>
						{error}
					</p>
				) : null}
			</Field>
			{keyCheck.candidates.length > 0 ? (
				<KeylessModelPicker
					candidates={keyCheck.candidates}
					current={current}
					currentDefault={currentDefault}
					disabled={disabled}
					idPrefix="application-keyless-model"
					key={keyCheck.candidates
						.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
						.join("|")}
					onChange={keyCheck.setSelection}
				/>
			) : null}
		</div>
	);
}
