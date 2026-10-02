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
			onSubmit: (body: AgentApplicationUpdateRequestV2Writable) => void;
			result?: AgentApplicationProjectionV2;
			submitting: boolean;
			onRefreshDeploymentConfiguration?: () => void;
			deploymentConfigurationRetryable?: boolean;
			refreshingDeploymentConfiguration?: boolean;
	  };

export function AgentApplicationSubmissionScreen(
	props: AgentApplicationSubmissionScreenProps,
) {
	const resultRef = useResultFocus(props.result);
	const heading =
		props.mode === "create"
			? "创建一个新的 Agent。"
			: agentApplicationEditActionLabels[props.action];
	const cancelLabel = props.mode === "create" ? "退出创建" : "取消";
	const cancelAction = props.submitting ? (
		<span
			className={buttonVariants({ variant: "outline" })}
			aria-disabled="true"
		>
			{cancelLabel}
		</span>
	) : props.mode === "update" ? (
		<Link
			className={buttonVariants({ variant: "outline" })}
			params={{ applicationId: props.application.applicationId }}
			to="/my-agents/$applicationId"
		>
			取消
		</Link>
	) : (
		<Link className={buttonVariants({ variant: "outline" })} to="/my-agents">
			{cancelLabel}
		</Link>
	);
	const validationError =
		props.error?.code === "INVALID_REQUEST" ||
		props.error?.code === "MODEL_SELECTION_INVALID";
	const deploymentUnavailable =
		props.deploymentConfiguration.status !== "populated" ||
		props.deploymentConfiguration.modelCatalog.status !== "populated";
	const deploymentRetryable = props.deploymentConfigurationRetryable ?? false;

	return (
		<section aria-labelledby="agent-application-submission-heading">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">我的管理 / 创建申请</p>
					<h1 id="agent-application-submission-heading">
						{props.result ? "申请已提交" : heading}
					</h1>
					<p>
						先说明使用场景，再配置
						Owner、范围、模型和渠道。服务端会重新校验全部字段。
					</p>
				</div>
				{props.mode === "create" ? cancelAction : null}
			</header>
			<div className="form-layout full-width-form">
				<div className="min-w-0">
					{!props.result && (
						<ol className="form-stepper" aria-label="申请填写顺序">
							<li>基本信息</li>
							<li>配置</li>
							<li>范围</li>
							<li>提交</li>
						</ol>
					)}
					{deploymentUnavailable ? (
						<div className="mb-4 flex items-center gap-3" role="status">
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
						<Alert variant="destructive" className="my-3">
							<AlertDescription>
								{validationError
									? "申请内容未通过服务端校验，请检查字段后重试。"
									: props.error.retryable === false
										? "申请已变更或当前不可用，请刷新页面后核对。"
										: "申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。"}
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
						/>
					)}
					{props.result ? (
						<Alert
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
						<Link
							className={buttonVariants({ variant: "link", className: "px-0" })}
							params={{ applicationId: props.result.applicationId }}
							to="/my-agents/$applicationId"
						>
							查看申请详情
						</Link>
					) : null}
				</div>
			</div>
		</section>
	);
}
