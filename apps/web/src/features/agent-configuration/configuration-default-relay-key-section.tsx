import { Activity, KeyRoundIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type {
	AgentConfigurationRequestError,
	AgentDefaultRelayKeyCheck,
	AgentDefaultRelayKeyState,
} from "./agent-configuration.js";
import { ConfigurationHeadSection } from "./configuration-section-head.js";
import {
	DefaultRelayKeyDialog,
	type DefaultRelayKeyReplacement,
	defaultRelayKeyFailureText,
} from "./default-relay-key-dialog.js";
import {
	candidateKey,
	type KeylessEndpointNames,
	type KeylessModelCandidate,
	keylessCandidateLabels,
} from "./keyless-model-selection.js";

/** 默认 Key 的读写操作；全部是独立请求，不经过整页保存，也不写页面级错误。 */
export type DefaultRelayKeyActions = {
	check: (keyValue: string) => Promise<AgentDefaultRelayKeyCheck>;
	replaceKey: (
		replacement: DefaultRelayKeyReplacement,
	) => Promise<AgentDefaultRelayKeyState>;
	replaceKeyWithModels: (
		body: AgentConfigurationUpdateRequestV2Writable,
	) => Promise<AgentProjectionV2>;
};

type ConfigurationDefaultRelayKeySectionProps = {
	actions: DefaultRelayKeyActions;
	agent: AgentProjectionV2;
	disabled: boolean;
	endpointNames?: KeylessEndpointNames;
	/** 默认 Key 状态；未读取到时只显示说明与替换入口。 */
	keyState?: AgentDefaultRelayKeyState;
	/** 替换进行中：页面据此禁用模型选择器（RK2-08）。 */
	onBusyChange: (busy: boolean) => void;
	savedCandidates?: readonly KeylessModelCandidate[];
	savedCandidatesLoading: boolean;
};

/**
 * 「可用模型」只读 tag（设计「GPT-6.1 · 均衡」）：模型名 + 中文档位；同名模型来自多个端点时
 * 才带端点显示名区分。
 */
function availableModelTags(
	candidates: readonly KeylessModelCandidate[],
	endpointNames: KeylessEndpointNames | undefined,
) {
	const labels = keylessCandidateLabels(candidates, endpointNames);
	return candidates.map((candidate) => {
		const displayName = candidate.displayName ?? candidate.modelId;
		const unique =
			candidates.filter(
				(item) => (item.displayName ?? item.modelId) === displayName,
			).length === 1;
		const name = unique
			? displayName
			: (labels.get(candidateKey(candidate)) ?? candidate.modelId);
		return {
			key: candidateKey(candidate),
			text: `${name} · ${candidate.reasoningLevels.map(reasoningLevelLabel).join("/")}`,
		};
	});
}

/**
 * 「Agent 默认 Relay Key」分区（G-08、G-09）：使用边界、状态 chip、当前版本、可用模型与
 * 「替换默认 Key」弹窗。密钥值只显示状态，不回显。
 */
export function ConfigurationDefaultRelayKeySection({
	actions,
	agent,
	disabled,
	endpointNames,
	keyState,
	onBusyChange,
	savedCandidates,
	savedCandidatesLoading,
}: ConfigurationDefaultRelayKeySectionProps) {
	const toast = useToast();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [verifying, setVerifying] = useState(false);
	const [failure, setFailure] = useState<AgentConfigurationRequestError | null>(
		null,
	);
	// 替换成功后先显示响应里的新版本，状态查询回读后以查询为准。
	const [replacedVersion, setReplacedVersion] = useState<number>();
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const isSet = keyState?.isSet === true;
	const keyVersion =
		replacedVersion !== undefined &&
		(keyState?.keyVersion ?? 0) < replacedVersion
			? replacedVersion
			: keyState?.keyVersion;
	const current = agent.configuration.modelOptions;
	const currentDefault = {
		optionId: agent.configuration.defaultModelOptionId ?? "",
		level: agent.configuration.defaultReasoningLevel ?? "",
	};

	const replaceKey = async (replacement: DefaultRelayKeyReplacement) => {
		setFailure(null);
		setVerifying(true);
		onBusyChange(true);
		try {
			const state = await actions.replaceKey(replacement);
			if (state.isSet) setReplacedVersion(state.keyVersion);
			toast("Agent 默认 Relay Key 已替换");
		} catch (error) {
			setFailure(error as AgentConfigurationRequestError);
		} finally {
			setVerifying(false);
			onBusyChange(false);
			buttonRef.current?.focus();
		}
	};

	const tags =
		savedCandidates === undefined
			? undefined
			: availableModelTags(savedCandidates, endpointNames);

	return (
		<ConfigurationHeadSection
			data-od-id="owner-default-relay-key"
			title="Agent 默认 Relay Key"
			description="供 API、评测和后台任务使用；Web 对话和企微继续使用个人 Key。"
			aside={
				isSet ? (
					<Badge tone={verifying ? "amber" : "green"}>
						{verifying ? "校验中" : "已设置"}
					</Badge>
				) : null
			}
		>
			{isSet && verifying ? (
				<Alert
					tone="info"
					role="status"
					icon={<Activity aria-hidden="true" />}
					className="configuration-relay-key-notice"
				>
					<AlertTitle>正在校验默认 Key</AlertTitle>
					<AlertDescription>
						保留当前配置，完成后会更新可用模型。
					</AlertDescription>
				</Alert>
			) : null}
			{isSet && !verifying ? (
				<dl className="configuration-facts">
					<dt>当前版本</dt>
					<dd>version {keyVersion}</dd>
					<dt>可用模型</dt>
					<dd>
						{tags === undefined ? (
							savedCandidatesLoading ? (
								"正在读取…"
							) : (
								"暂时无法读取"
							)
						) : tags.length === 0 ? (
							"无"
						) : (
							<div className="tag-row">
								{tags.map((tag) => (
									<Badge key={tag.key} variant="tag">
										{tag.text}
									</Badge>
								))}
							</div>
						)}
					</dd>
					<dt>密钥值</dt>
					<dd>只显示状态，不回显</dd>
				</dl>
			) : null}
			{failure ? (
				<Alert
					tone="danger"
					role="alert"
					className="configuration-relay-key-notice"
				>
					<AlertTitle>默认 Key 未替换</AlertTitle>
					<AlertDescription>
						{defaultRelayKeyFailureText(failure)}
					</AlertDescription>
				</Alert>
			) : null}
			<div className="card-actions">
				<Button
					ref={buttonRef}
					type="button"
					variant="outline"
					disabled={disabled || verifying}
					focusableWhenDisabled
					onClick={() => {
						if (disabled || verifying) return;
						setFailure(null);
						setDialogOpen(true);
					}}
				>
					<KeyRoundIcon aria-hidden="true" data-icon="inline-start" />
					替换默认 Key
				</Button>
			</div>
			<DefaultRelayKeyDialog
				open={dialogOpen}
				current={current}
				currentDefault={currentDefault}
				endpointNames={endpointNames}
				finalFocus={buttonRef}
				onClose={() => setDialogOpen(false)}
				onCheck={actions.check}
				onCovered={(replacement) => void replaceKey(replacement)}
				onReplaceWithModels={actions.replaceKeyWithModels}
				onReplacedWithModels={() => {
					toast("Agent 默认 Relay Key 已替换");
					buttonRef.current?.focus();
				}}
			/>
		</ConfigurationHeadSection>
	);
}
