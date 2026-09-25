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

type RequestError = Error & { readonly retryable?: boolean };

type AgentApplicationSubmissionScreenProps =
	| {
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			error?: RequestError | null;
			mode: "create";
			onSubmit: (body: AgentApplicationCreateRequestV2Writable) => void;
			result?: AgentApplicationProjectionV2;
			submitting: boolean;
			onRefreshDeploymentConfiguration?: () => void;
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
			refreshingDeploymentConfiguration?: boolean;
	  };

export function AgentApplicationSubmissionScreen(
	props: AgentApplicationSubmissionScreenProps,
) {
	const resultRef = useResultFocus(props.result);
	const heading =
		props.mode === "create"
			? "申请 Agent"
			: agentApplicationEditActionLabels[props.action];
	const cancelAction = props.submitting ? (
		<span
			className={buttonVariants({ variant: "outline" })}
			aria-disabled="true"
		>
			取消
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
			取消
		</Link>
	);

	return (
		<section aria-labelledby="agent-application-submission-heading">
			<header className="page-heading">
				<div>
					<h1 id="agent-application-submission-heading">{heading}</h1>
					<p>配置用途与使用范围，提交后由管理员审批。</p>
				</div>
			</header>
			<div className="form-layout">
				<div className="min-w-0">
					{props.deploymentConfiguration.status !== "populated" ||
					props.deploymentConfiguration.modelCatalog.status !== "populated" ? (
						<div className="mb-4 flex items-center gap-3" role="status">
							<p className="text-muted-foreground text-sm">
								部署选项需要刷新后才能提交标准模板申请。
							</p>
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
						</div>
					) : null}
					{props.error ? (
						<Alert variant="destructive" className="my-3">
							<AlertDescription>
								{props.error.retryable === false
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
				<aside className="form-aside">
					<h2>申请说明</h2>
					<p>审批用于确认预设资源占用。</p>
					<ol>
						<li>填写配置并提交申请</li>
						<li>管理员审阅</li>
						<li>批准后创建 Agent</li>
					</ol>
					<p>审批结果可在申请详情中查看。</p>
					<p className="text-muted-foreground text-sm">
						模板、人员与获准模型端点由部署环境提供。当前按已提供的 ID
						填写，服务端会校验权限与配置。
					</p>
				</aside>
			</div>
		</section>
	);
}
