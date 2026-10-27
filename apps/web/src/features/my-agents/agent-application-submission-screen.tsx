import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useResultFocus } from "@/hooks/use-result-focus";
import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
	DeploymentConfigurationProjectionV2,
	DeploymentModelEndpointProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type { AgentDefaultRelayKeyCheck } from "../agent-configuration/agent-configuration.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { RecoveryButton } from "../recovery-button.js";
import { AgentApplicationForm } from "./agent-application-form.js";
import { deploymentConfigurationUsable } from "./deployment-configuration.js";
import {
	type AgentApplicationEditAction,
	agentApplicationEditActionLabels,
} from "./my-agent-applications.js";
import type { loadApplicationModelCandidates } from "./use-application-model-candidates.js";

type RequestError = Error & {
	readonly code?: string;
	readonly retryable?: boolean;
};

type AgentApplicationSubmissionScreenProps =
	| {
			connectionUrl?: string;
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			error?: RequestError | null;
			mode: "create";
			onCheckApplicationModels?: typeof loadApplicationModelCandidates;
			onSubmit: (body: AgentApplicationCreateRequestV2Writable) => void;
			result?: AgentApplicationProjectionV2;
			submitting: boolean;
			onRefreshDeploymentConfiguration?: () => void;
			deploymentConfigurationRetryable?: boolean;
			/** 最近一次读到的模型目录端点：部署选项读取失败时只用于显示名称（#3418 N14-06）。 */
			lastReadModelEndpoints?: readonly DeploymentModelEndpointProjectionV2[];
			refreshingDeploymentConfiguration?: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV2;
			connectionUrl?: string;
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			error?: RequestError | null;
			mode: "update";
			/** 模型由默认 Relay Key 管理：更换模型集合要重新提交 Key，并只能从该 Key 的候选里选。 */
			defaultRelayKeyManaged?: boolean;
			onCheckDefaultRelayKey?: (
				keyValue: string,
			) => Promise<AgentDefaultRelayKeyCheck>;
			onSubmit: (body: AgentApplicationUpdateRequestV2Writable) => void;
			result?: AgentApplicationProjectionV2;
			submitting: boolean;
			onRefreshDeploymentConfiguration?: () => void;
			deploymentConfigurationRetryable?: boolean;
			/** 最近一次读到的模型目录端点：部署选项读取失败时只用于显示名称（#3418 N14-06）。 */
			lastReadModelEndpoints?: readonly DeploymentModelEndpointProjectionV2[];
			refreshingDeploymentConfiguration?: boolean;
	  };

/** 设计 #application-form 的页面标题；路由读取中的占位标题与它一致。 */
export const createApplicationHeading = "创建 Agent";

export function AgentApplicationSubmissionScreen(
	props: AgentApplicationSubmissionScreenProps,
) {
	const resultRef = useResultFocus(props.result);
	// G4-14（同 W-15）：提交或修改并重新提交受理后，用 Toast 补充确认已进入审批队列；每个结果只提示一次。
	// 页内提示获得焦点后由读屏读出，不再另设 role="status"，避免与 Toast 两个 live region 重复播报。
	const toast = useToast();
	const announced = useRef<AgentApplicationProjectionV2 | undefined>(undefined);
	useEffect(() => {
		const result = props.result;
		if (!result || announced.current === result) return;
		announced.current = result;
		if (result.status === "pending_approval")
			toast("申请已提交，已进入系统管理员审批队列");
	}, [props.result, toast]);
	const heading =
		props.mode === "create"
			? createApplicationHeading
			: agentApplicationEditActionLabels[props.action];
	// 设计 .form-footer 左侧唯一的退出入口：ghost「取消」，页头不再放退出操作（N-03）。
	const cancelAction = props.submitting ? (
		<span className={buttonVariants({ variant: "ghost" })} aria-disabled="true">
			取消
		</span>
	) : props.mode === "update" ? (
		<Link
			activeOptions={{ exact: true }}
			className={buttonVariants({ variant: "ghost" })}
			params={{ applicationId: props.application.applicationId }}
			to="/my-agents/$applicationId"
		>
			取消
		</Link>
	) : (
		<Link
			activeOptions={{ exact: true }}
			className={buttonVariants({ variant: "ghost" })}
			to="/my-agents"
		>
			取消
		</Link>
	);
	// ACTION_UNAVAILABLE：部署未提供所选入口身份校验（#3034），具体原因在表单字段下说明。
	const validationError =
		props.error?.code === "INVALID_REQUEST" ||
		props.error?.code === "MODEL_SELECTION_INVALID" ||
		props.error?.code === "ACTION_UNAVAILABLE";
	// 修改申请不能更改入口身份：不引导「检查字段后重试」，提示新建申请；表单把焦点交给这条提示
	// （#3291 N9-2-03）。创建申请仍可改选「由自有入口校验」，沿用通用文案。
	const identityEntryUnavailable =
		props.mode === "update" &&
		props.error?.code === "ACTION_UNAVAILABLE" &&
		props.application.source.kind === "custom" &&
		props.application.source.interactionMode === "self-managed" &&
		props.application.source.identityResponsibility === "platform-managed";
	const deploymentUnavailable = !deploymentConfigurationUsable(
		props.deploymentConfiguration,
		props.mode === "create" && props.onCheckApplicationModels !== undefined,
	);
	const deploymentRetryable = props.deploymentConfigurationRetryable ?? false;
	const submissionFailureMessage =
		props.error?.code === "DEPENDENCY_UNAVAILABLE" ||
		props.error?.code === "INTERNAL_ERROR"
			? "申请提交失败，部署依赖暂不可用，请稍后重试。"
			: "申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。";
	// 提交失败只在页面顶部说明一次（表单顶部的 danger 提示，tabIndex=-1）；服务端整表校验失败
	// （INVALID_REQUEST）时表单把焦点交给这条提示，不再在表单内重复同一结论（#3268 N8-2-03）；修改申请的
	// 入口身份不可用（ACTION_UNAVAILABLE）时同样聚焦这里（#3291 N9-2-03）；503、500 与不可重试的 409 等
	// 非校验类失败也滚入视口并聚焦这里（#3351 N11-02）。
	const submissionErrorMessage = props.error
		? identityEntryUnavailable
			? "当前部署不支持此申请的入口身份校验，请新建申请。"
			: validationError
				? "申请内容未通过服务端校验，请检查字段后重试。"
				: props.error.retryable === false
					? "申请已变更或当前不可用，请刷新页面后核对。"
					: submissionFailureMessage
		: undefined;

	return (
		<section aria-labelledby="agent-application-submission-heading">
			<header className="page-heading">
				<div>
					{/* eyebrow 与面包屑、页面标题使用同一页面名（page-chrome）。 */}
					<p className="page-eyebrow">
						{props.mode === "create"
							? "我的管理 / 创建申请"
							: "我的管理 / 编辑申请"}
					</p>
					<h1 id="agent-application-submission-heading">
						{props.result ? "申请已提交" : heading}
					</h1>
					{/* 设计 #application-form 原文去掉「渠道」：渠道分区随 #2862 M-10 决定。 */}
					<p>填写使用场景，再配置 Owner、范围和模型。提交时会重新校验字段。</p>
				</div>
			</header>
			<div className="form-layout full-width-form application-form-layout">
				<div className="application-form-card min-w-0">
					{!props.result && (
						<ol className="form-stepper" aria-label="申请填写顺序">
							<li className="done">基本信息</li>
							<li className="active">配置</li>
							<li>范围</li>
							<li>提交</li>
						</ol>
					)}
					{/* 部署状态说明只服务于还没提交的表单：提交受理后的结果页不再显示它与「重新加载部署选项」
					    （#3389 N13-09）。部署选项不可用时标准模板申请被拦下、没有可操作的出错字段，焦点交给
					    「重新加载部署选项」（不可重试时交给说明本身，tabIndex=-1），按钮经 aria-describedby 带上
					    说明（#3389 N13-10）。 */}
					{deploymentUnavailable && !props.result ? (
						<div
							className="application-deployment-status"
							id="application-deployment-status"
							role="status"
							tabIndex={-1}
						>
							<p
								className="text-muted-foreground text-sm"
								id="application-deployment-status-message"
							>
								{deploymentRetryable
									? "部署选项需要刷新后才能提交标准模板申请。"
									: "部署选项暂不可用，请联系管理员。"}
							</p>
							{deploymentRetryable && props.onRefreshDeploymentConfiguration ? (
								<RecoveryButton
									aria-describedby="application-deployment-status-message"
									variant="outline"
									recoveryKey="重新加载部署选项"
									busy={props.refreshingDeploymentConfiguration}
									onClick={props.onRefreshDeploymentConfiguration}
								>
									{props.refreshingDeploymentConfiguration
										? "正在刷新…"
										: "重新加载部署选项"}
								</RecoveryButton>
							) : null}
						</div>
					) : null}
					{props.result ? null : (
						<AgentApplicationForm
							key={
								props.mode === "update"
									? props.application.applicationId
									: "create"
							}
							{...props}
							cancelAction={cancelAction}
							serverError={props.error}
							showDeploymentStatus={false}
							submissionErrorMessage={submissionErrorMessage}
						/>
					)}
					{props.result ? (
						<Alert
							tone="info"
							ref={resultRef}
							tabIndex={-1}
							// 设计 .notice p：提交结果为常规字重（W-08）；提示紧贴卡片内边距，
							// 不加上外边距（B2-02），与下方操作的间距由 .card-actions 上距给出。
							className="mb-3"
						>
							<AlertDescription>
								申请已提交：{agentManagementStatusLabels[props.result.status]}。
							</AlertDescription>
						</Alert>
					) : null}
					{props.result ? (
						<div className="card-actions application-submitted-actions">
							{/* exact：修改申请（/my-agents/$applicationId/edit）提交后，申请详情是当前地址的
							    前缀，不让 Link 补 aria-current（N-21）。 */}
							<Link
								activeOptions={{ exact: true }}
								className={buttonVariants()}
								params={{ applicationId: props.result.applicationId }}
								to="/my-agents/$applicationId"
							>
								查看申请详情
							</Link>
							<Link
								activeOptions={{ exact: true }}
								className={buttonVariants({ variant: "ghost" })}
								to="/my-agents"
							>
								返回我的 Agent
							</Link>
						</div>
					) : null}
				</div>
			</div>
		</section>
	);
}
