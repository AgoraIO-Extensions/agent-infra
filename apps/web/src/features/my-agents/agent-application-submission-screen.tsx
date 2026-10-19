import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { useResultFocus } from "@/hooks/use-result-focus";

import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
	DeploymentConfigurationProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type { AgentDefaultRelayKeyCheck } from "../agent-configuration/agent-configuration.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { AgentApplicationForm } from "./agent-application-form.js";
import {
	type AgentApplicationEditAction,
	agentApplicationEditActionLabels,
} from "./my-agent-applications.js";

type RequestError = Error & {
	readonly code?: string;
	readonly retryable?: boolean;
};

type AgentApplicationSubmissionScreenProps =
	| {
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			error?: RequestError | null;
			mode: "create";
			onSubmit: (body: AgentApplicationCreateRequestV2Writable) => void;
			result?: AgentApplicationProjectionV2;
			submitting: boolean;
			onRefreshDeploymentConfiguration?: () => void;
			deploymentConfigurationRetryable?: boolean;
			refreshingDeploymentConfiguration?: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV2;
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
			refreshingDeploymentConfiguration?: boolean;
	  };

/** 设计 #application-form 的页面标题；路由读取中的占位标题与它一致。 */
export const createApplicationHeading = "创建 Agent";

export function AgentApplicationSubmissionScreen(
	props: AgentApplicationSubmissionScreenProps,
) {
	const resultRef = useResultFocus(props.result);
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
	const validationError =
		props.error?.code === "INVALID_REQUEST" ||
		props.error?.code === "MODEL_SELECTION_INVALID";
	const deploymentUnavailable =
		props.deploymentConfiguration.status !== "populated" ||
		props.deploymentConfiguration.modelCatalog.status !== "populated";
	const deploymentRetryable = props.deploymentConfigurationRetryable ?? false;
	const submissionFailureMessage =
		props.error?.code === "DEPENDENCY_UNAVAILABLE" ||
		props.error?.code === "INTERNAL_ERROR"
			? "申请提交失败，部署依赖暂不可用，请稍后重试。"
			: "申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。";

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
					{deploymentUnavailable ? (
						<div
							className="application-deployment-status"
							id="application-deployment-status"
							role="status"
						>
							<p className="text-muted-foreground text-sm">
								{deploymentRetryable
									? "部署选项需要刷新后才能提交标准模板申请。"
									: "部署选项暂不可用，请联系管理员。"}
							</p>
							{deploymentRetryable && props.onRefreshDeploymentConfiguration ? (
								<Button
									variant="outline"
									disabled={props.refreshingDeploymentConfiguration}
									onClick={props.onRefreshDeploymentConfiguration}
									type="button"
								>
									{props.refreshingDeploymentConfiguration
										? "正在刷新…"
										: "重新加载部署选项"}
								</Button>
							) : null}
						</div>
					) : null}
					{props.error ? (
						<Alert
							tone="danger"
							role="alert"
							className="application-form-alert"
						>
							<AlertDescription>
								{validationError
									? "申请内容未通过服务端校验，请检查字段后重试。"
									: props.error.retryable === false
										? "申请已变更或当前不可用，请刷新页面后核对。"
										: submissionFailureMessage}
							</AlertDescription>
						</Alert>
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
						/>
					)}
					{props.result ? (
						<Alert
							tone="info"
							ref={resultRef}
							tabIndex={-1}
							className="my-3 font-medium"
							role="status"
						>
							<AlertDescription>
								申请已提交：{agentManagementStatusLabels[props.result.status]}。
							</AlertDescription>
						</Alert>
					) : null}
					{props.result ? (
						<div className="card-actions application-submitted-actions">
							<Link
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
