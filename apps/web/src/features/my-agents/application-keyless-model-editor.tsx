import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { ConfigurationModelPicker } from "../agent-configuration/configuration-model-picker.js";
import type {
	KeylessCurrentModelOption,
	KeylessEndpointNames,
} from "../agent-configuration/keyless-model-selection.js";
import type { useKeylessKeyCheck } from "../agent-configuration/use-keyless-key-check.js";

type ApplicationKeylessModelEditorProps = {
	current: readonly KeylessCurrentModelOption[];
	currentDefault: { optionId: string; level: string };
	disabled: boolean;
	/** 端点 ID → 部署目录显示名，候选不显示原始端点 ID（G5-12）。 */
	endpointNames?: KeylessEndpointNames;
	/** 表单校验或保存被拦下时的提示。 */
	error?: string | undefined;
	errorId: string;
	keyCheck: ReturnType<typeof useKeylessKeyCheck>;
	onChangeKey: () => void;
};

/**
 * 编辑由默认 Relay Key 管理模型的申请（#2421）：重新输入 Key，检查后只能从该 Key 可见的
 * 模型里选择；保存时 Key、模型集合和检查时看到的版本一起提交。模型选择与 Owner 配置
 * 「模型与凭证」是同一个选择器（说明 13px、单个「默认模型选项」、公共字段错误，#3268 N8-2-05）。
 */
export function ApplicationKeylessModelEditor({
	current,
	currentDefault,
	disabled,
	endpointNames,
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
					{/* 检查进行中是可聚焦的禁用（aria-disabled），焦点留在按钮上（#3242 K7-02）。 */}
					<Button
						disabled={disabled || keyCheck.checking || !keyCheck.typed}
						focusableWhenDisabled={keyCheck.checking}
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
					<Alert tone="danger" role="alert">
						<AlertDescription>
							Key 校验失败或暂时无法读取可用模型，请检查后重试。
						</AlertDescription>
					</Alert>
				) : null}
				{/* 拦截错误与表单其他字段错误同一套公共样式与播报方式（#3268 N8-2-02）。 */}
				{error ? (
					<FieldError announce="polite" className="field-error" id={errorId}>
						{error}
					</FieldError>
				) : null}
			</Field>
			{/* 检查成功但没有候选：与 Owner 配置「当前默认 Key 没有此模板可用的模型」、替换 Key 弹窗
			    「新的 Key 没有此模板可用的模型」同一种 warn 提示（#3268 N8-2-05）。 */}
			{keyCheck.noCandidates ? (
				<Alert tone="warn" role="status">
					<AlertTitle>该 Key 没有此模板可用的模型</AlertTitle>
					<AlertDescription>
						请换一个 Key 后重新检查；当前模型配置保持不变。
					</AlertDescription>
				</Alert>
			) : null}
			{keyCheck.candidates.length > 0 ? (
				<ConfigurationModelPicker
					candidates={keyCheck.candidates}
					current={current}
					currentDefault={currentDefault}
					description="只列出该 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认模型选项。"
					disabled={disabled}
					endpointNames={endpointNames}
					idPrefix="application-keyless-model"
					key={keyCheck.candidates
						.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
						.join("|")}
					removedTitle="提交后会移除这些模型"
					onChange={({ selection }) => keyCheck.setSelection(selection)}
				/>
			) : null}
		</div>
	);
}
