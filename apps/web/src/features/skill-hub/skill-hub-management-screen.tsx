import { Link } from "@tanstack/react-router";
import {
	CheckCircle2,
	ClipboardCheck,
	FolderKanban,
	PackageOpen,
	RefreshCw,
} from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type {
	SkillHubAgentBindingCommandV1,
	SkillHubProjectCreateV1,
	SkillHubProviderImportRequestV1,
	SkillHubPublicationRequestV1,
	SkillHubPublicationResponseV1,
	SkillHubReviewRequestV1,
} from "../../pilot/generated-v2/types.gen.js";
import type { SkillHubDirectoryState } from "./skill-hub.js";
import {
	bindSkillHubAgentVersion,
	createSkillHubProject,
	importSkillHubVersion,
	listSkillHubProjects,
	publishSkillHubVersion,
	readSkillHubAgentBindings,
	reviewSkillHubVersion,
	revokeSkillHubVersion,
	updateSkillHubProject,
} from "./skill-hub-management.js";
import {
	skillHubProviderLabels,
	skillHubVisibilityLabels,
} from "./skill-hub-screen.js";

export type SkillHubManagementActions = {
	createProject: typeof createSkillHubProject;
	listProjects: typeof listSkillHubProjects;
	updateProject: typeof updateSkillHubProject;
	importVersion: typeof importSkillHubVersion;
	publishVersion: typeof publishSkillHubVersion;
	reviewVersion: typeof reviewSkillHubVersion;
	revokeVersion: typeof revokeSkillHubVersion;
	readBindings: typeof readSkillHubAgentBindings;
	bindVersion: typeof bindSkillHubAgentVersion;
};

const defaultActions: SkillHubManagementActions = {
	createProject: createSkillHubProject,
	listProjects: listSkillHubProjects,
	updateProject: updateSkillHubProject,
	importVersion: importSkillHubVersion,
	publishVersion: publishSkillHubVersion,
	reviewVersion: reviewSkillHubVersion,
	revokeVersion: revokeSkillHubVersion,
	readBindings: readSkillHubAgentBindings,
	bindVersion: bindSkillHubAgentVersion,
};

type FormState = { busy: boolean; message?: string };
type SkillHubPublicationDraft = Omit<
	SkillHubPublicationRequestV1,
	"packageObjectVersion"
>;

function publicationMessage(
	action: string,
	result: SkillHubPublicationResponseV1,
) {
	const replay = result.replayed ? "（服务端重放）" : "";
	const reason = result.version.reviewReason
		? `，原因：${result.version.reviewReason}`
		: "";
	return `${action}成功：服务端状态 ${result.version.state}${replay}${reason}。`;
}

function bindingMessage(
	bindings: Awaited<ReturnType<typeof readSkillHubAgentBindings>>["bindings"],
) {
	if (bindings.length === 0) return "服务端绑定状态：暂无绑定。";
	return `服务端绑定状态：${bindings
		.map((binding) => {
			if (binding.state === "synced" && binding.appliedReceipt) {
				return `synced / Applied（${binding.appliedReceipt.targetPath}）`;
			}
			if (binding.state === "failed")
				return `failed（${binding.failureReason}）`;
			return binding.state;
		})
		.join("、")}。`;
}

function actionFailureMessage(error: unknown) {
	const requestError =
		error && typeof error === "object"
			? (error as { code?: string; retryable?: boolean; status?: number })
			: {};
	if (requestError.status === 503)
		return "Skill Hub 后端暂时不可用，可稍后重试。";
	if (requestError.retryable) return "Skill Hub 操作暂时失败，可稍后重试。";
	if (requestError.status === 409)
		return "操作冲突，当前状态或配置 revision 已变化，请刷新后重试。";
	return requestError.code
		? `操作被拒绝（${requestError.code}）。`
		: "操作失败，请检查输入后重试。";
}

export function SkillHubManagementScreen({
	state,
	isAdministrator,
	onRetry,
	retrying = false,
	actions = defaultActions,
	publicationSource,
}: {
	state: SkillHubDirectoryState | { kind: "loading" };
	isAdministrator: boolean;
	onRetry?: () => void;
	retrying?: boolean;
	actions?: SkillHubManagementActions;
	/** Server-provided object version; storage locations never come from user input. */
	publicationSource?: string;
}) {
	const versions = state.kind === "ready" ? state.versions : [];
	const publishedVersionIds = new Set(
		versions.map((version) => version.skillVersionId),
	);
	const [project, setProject] = useState<FormState>({ busy: false });
	const [projectName, setProjectName] = useState("");
	const [projectId, setProjectId] = useState("");
	const [projectStatus, setProjectStatus] = useState<"active" | "disabled">(
		"active",
	);
	const [projects, setProjects] = useState<
		Awaited<ReturnType<typeof listSkillHubProjects>>["items"]
	>([]);
	const [importState, setImportState] = useState<FormState>({ busy: false });
	const [importForm, setImportForm] = useState({
		name: "",
		provider: "my_library" as SkillHubProviderImportRequestV1["provider"],
		version: "",
	});
	const [publishState, setPublishState] = useState<FormState>({ busy: false });
	const [publishForm, setPublishForm] = useState<SkillHubPublicationDraft>({
		schemaVersion: 1,
		name: "",
		skillId: "",
		skillVersionId: "",
		visibility: "PRIVATE",
		provider: "my_library",
		version: "",
		packageDigest: "",
		manifestDigest: "",
		signatureDigest: "",
	});
	const [reviewState, setReviewState] = useState<FormState>({ busy: false });
	const [reviewForm, setReviewForm] = useState({
		skillVersionId: "",
		decision: "approve" as SkillHubReviewRequestV1["decision"],
		reason: "",
	});
	const [bindingState, setBindingState] = useState<FormState>({ busy: false });
	const [bindingForm, setBindingForm] = useState({
		agentId: "",
		agentVersion: "",
		revision: "1",
		skillVersionId: "",
		grant:
			'{"schemaVersion":1,"tools":[],"connections":[],"fileRoots":[],"networkOrigins":[],"scripts":false}',
	});
	const operationKeys = useRef(
		new Map<string, { fingerprint: string; key: string }>(),
	);

	function idempotencyKey(scope: string, input: unknown) {
		const fingerprint = JSON.stringify(input);
		const previous = operationKeys.current.get(scope);
		if (previous?.fingerprint === fingerprint) return previous.key;
		const key = crypto.randomUUID();
		operationKeys.current.set(scope, { fingerprint, key });
		return key;
	}

	async function run(
		scope: string,
		setState: (state: FormState | ((previous: FormState) => FormState)) => void,
		operation: () => Promise<string | undefined>,
	) {
		setState({ busy: true });
		try {
			const message = await operation();
			operationKeys.current.delete(scope);
			setState((previous) => ({
				busy: false,
				message:
					message ?? previous.message ?? "操作已提交，服务端状态已更新。",
			}));
		} catch (error) {
			setState({ busy: false, message: actionFailureMessage(error) });
		}
	}

	async function submitProject(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const body: SkillHubProjectCreateV1 = {
			schemaVersion: 1,
			name: projectName.trim(),
		};
		await run("project-create", setProject, async () => {
			const result = await actions.createProject(
				body,
				idempotencyKey("project-create", body),
			);
			setProjects((await actions.listProjects()).items);
			setProjectName("");
			return `项目已创建：${result.name}。`;
		});
	}

	return (
		<section aria-labelledby="skill-hub-management-heading">
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">我的管理 / 我的 Skill</p>
					<h1 id="skill-hub-management-heading">管理固定版本与 Agent 配置。</h1>
					<p>
						项目、发布、审核和 Agent
						配置共用同一版本事实；每次写入都由服务端授权并带幂等键。
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Link className={buttonVariants({ variant: "outline" })} to="/skills">
						打开 Skill 目录
					</Link>
					<Button
						type="button"
						variant="ghost"
						onClick={onRetry}
						disabled={retrying}
					>
						<RefreshCw
							className={retrying ? "animate-spin" : ""}
							aria-hidden="true"
						/>
						刷新
					</Button>
				</div>
			</header>
			{state.kind === "loading" ? (
				<p role="status">正在加载 Skill 版本…</p>
			) : state.kind === "unavailable" ? (
				<Alert>
					<AlertDescription>
						{state.retryable
							? "Skill Hub 状态暂时无法读取。"
							: "当前账号无法读取 Skill Hub 状态。"}
					</AlertDescription>
					{state.retryable && onRetry ? (
						<Button onClick={onRetry}>重试</Button>
					) : null}
				</Alert>
			) : (
				<div className="space-y-5">
					<div className="grid gap-4 md:grid-cols-2">
						<ManagementCard
							icon={<FolderKanban aria-hidden="true" />}
							title="项目与导入"
							description="创建项目或从受控 Provider 导入固定版本。"
						>
							<form className="mt-4 space-y-3" onSubmit={submitProject}>
								<Field
									label="项目名称"
									value={projectName}
									onChange={setProjectName}
									required
								/>
								<Button
									type="submit"
									disabled={project.busy || !projectName.trim()}
								>
									创建项目
								</Button>
								{project.message ? (
									<ActionMessage value={project.message} />
								) : null}
							</form>
							<form
								className="mt-5 space-y-3 border-t pt-4"
								onSubmit={(event) => {
									event.preventDefault();
									void run("project-update", setProject, async () => {
										const body = {
											schemaVersion: 1 as const,
											name: projectName.trim(),
											status: projectStatus,
										};
										const result = await actions.updateProject(
											projectId.trim(),
											body,
											idempotencyKey("project-update", {
												projectId: projectId.trim(),
												body,
											}),
										);
										setProjects((await actions.listProjects()).items);
										return `项目已${result.status === "disabled" ? "停用" : "更新"}：${result.name}。`;
									});
								}}
							>
								<p className="font-medium text-sm">编辑/停用项目</p>
								<Field
									label="项目 ID"
									value={projectId}
									onChange={setProjectId}
									required
								/>
								<Field
									label="新名称"
									value={projectName}
									onChange={setProjectName}
									required
								/>
								<Label>
									状态
									<NativeSelect
										className="mt-1"
										value={projectStatus}
										onChange={(event) =>
											setProjectStatus(
												event.target.value as "active" | "disabled",
											)
										}
									>
										<NativeSelectOption value="active">启用</NativeSelectOption>
										<NativeSelectOption value="disabled">
											停用
										</NativeSelectOption>
									</NativeSelect>
								</Label>
								<Button
									type="submit"
									variant="outline"
									disabled={
										project.busy || !projectId.trim() || !projectName.trim()
									}
								>
									保存项目
								</Button>
							</form>
							{projects.length ? (
								<ul className="mt-4 space-y-1 text-sm" aria-label="Skill 项目">
									{projects.map((item) => (
										<li key={item.projectId}>
											{item.name} · {item.status}
										</li>
									))}
								</ul>
							) : null}
							<form
								className="mt-5 space-y-3 border-t pt-4"
								onSubmit={(event) => {
									event.preventDefault();
									void run("provider-import", setImportState, async () => {
										const body = {
											schemaVersion: 1 as const,
											name: importForm.name.trim(),
											provider: importForm.provider,
											version: importForm.version.trim(),
										};
										const result = await actions.importVersion(
											body,
											idempotencyKey("provider-import", body),
										);
										setImportForm({ ...importForm, name: "", version: "" });
										return publicationMessage("Provider 导入", result);
									});
								}}
							>
								<p className="font-medium text-sm">受控 Provider 导入</p>
								<Field
									label="名称"
									value={importForm.name}
									onChange={(value) =>
										setImportForm({ ...importForm, name: value })
									}
									required
								/>
								<Field
									label="Provider 版本/选择器"
									value={importForm.version}
									onChange={(value) =>
										setImportForm({ ...importForm, version: value })
									}
									required
								/>
								<ProviderSelect
									value={importForm.provider}
									onChange={(value) =>
										setImportForm({ ...importForm, provider: value })
									}
								/>
								<Button
									type="submit"
									disabled={
										importState.busy ||
										!importForm.name.trim() ||
										!importForm.version.trim()
									}
								>
									导入版本
								</Button>
								{importState.message ? (
									<ActionMessage value={importState.message} />
								) : null}
							</form>
						</ManagementCard>

						<ManagementCard
							icon={<PackageOpen aria-hidden="true" />}
							title="发布与版本"
							description="发布不可变版本；包来源由服务端受控提供。"
						>
							<form
								className="mt-4 grid gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									if (!publicationSource) {
										setPublishState({
											busy: false,
											message:
												"Skill Hub 后端暂时不可用：当前会话没有受控包来源，请稍后重试。",
										});
										return;
									}
									const body: SkillHubPublicationRequestV1 = {
										...publishForm,
										packageObjectVersion: publicationSource,
									};
									void run("publication", setPublishState, async () => {
										const result = await actions.publishVersion(
											body,
											idempotencyKey("publication", body),
										);
										return publicationMessage("版本发布", result);
									});
								}}
							>
								<Field
									label="名称"
									value={publishForm.name}
									onChange={(value) =>
										setPublishForm({ ...publishForm, name: value })
									}
									required
								/>
								<Field
									label="Skill ID"
									value={publishForm.skillId}
									onChange={(value) =>
										setPublishForm({ ...publishForm, skillId: value })
									}
									required
								/>
								<Field
									label="版本 ID"
									value={publishForm.skillVersionId}
									onChange={(value) =>
										setPublishForm({ ...publishForm, skillVersionId: value })
									}
									required
								/>
								<Field
									label="版本"
									value={publishForm.version}
									onChange={(value) =>
										setPublishForm({ ...publishForm, version: value })
									}
									required
								/>
								{publicationSource ? (
									<p className="text-muted-foreground text-sm" role="status">
										已使用服务端受控包来源。
									</p>
								) : (
									<p className="text-muted-foreground text-sm" role="status">
										当前会话尚未取得受控包来源，发布暂不可用。
									</p>
								)}
								<ProviderSelect
									value={publishForm.provider}
									onChange={(value) =>
										setPublishForm({ ...publishForm, provider: value })
									}
								/>
								<VisibilitySelect
									value={publishForm.visibility}
									onChange={(value) =>
										setPublishForm({ ...publishForm, visibility: value })
									}
								/>
								<Field
									label="Package digest"
									value={publishForm.packageDigest}
									onChange={(value) =>
										setPublishForm({ ...publishForm, packageDigest: value })
									}
									required
								/>
								<Field
									label="Manifest digest"
									value={publishForm.manifestDigest}
									onChange={(value) =>
										setPublishForm({ ...publishForm, manifestDigest: value })
									}
									required
								/>
								<Field
									label="Signature digest"
									value={publishForm.signatureDigest}
									onChange={(value) =>
										setPublishForm({ ...publishForm, signatureDigest: value })
									}
									required
								/>
								<Button
									type="submit"
									disabled={publishState.busy || !publicationSource}
								>
									发布版本
								</Button>
								{publishState.message ? (
									<ActionMessage value={publishState.message} />
								) : null}
							</form>
						</ManagementCard>

						<ManagementCard
							icon={<ClipboardCheck aria-hidden="true" />}
							title="共享审核"
							description={
								isAdministrator
									? "审核共享发布，或撤销已授权版本。"
									: "共享审核需要管理员；版本撤销由服务端校验 Owner 授权。"
							}
						>
							<form
								className="mt-4 space-y-3"
								onSubmit={(event) => {
									event.preventDefault();
									void run("review", setReviewState, async () => {
										const body = {
											decision: reviewForm.decision,
											...(reviewForm.reason.trim()
												? { reason: reviewForm.reason.trim() }
												: {}),
										};
										const result = await actions.reviewVersion(
											reviewForm.skillVersionId.trim(),
											body,
											idempotencyKey("review", {
												skillVersionId: reviewForm.skillVersionId.trim(),
												body,
											}),
										);
										return publicationMessage("审核", result);
									});
								}}
							>
								<Field
									label="Skill 版本 ID"
									value={reviewForm.skillVersionId}
									onChange={(value) =>
										setReviewForm({ ...reviewForm, skillVersionId: value })
									}
									required
								/>
								<p className="text-muted-foreground text-sm" role="status">
									{publishedVersionIds.has(reviewForm.skillVersionId.trim())
										? "当前授权目录确认该版本为 published，可申请撤销。"
										: "当前授权目录未确认 published 状态，撤销按钮保持不可用。"}
								</p>
								<Label>
									决定
									<NativeSelect
										className="mt-1"
										value={reviewForm.decision}
										onChange={(event) =>
											setReviewForm({
												...reviewForm,
												decision: event.target
													.value as SkillHubReviewRequestV1["decision"],
											})
										}
									>
										<NativeSelectOption value="approve">
											批准
										</NativeSelectOption>
										<NativeSelectOption value="reject">驳回</NativeSelectOption>
									</NativeSelect>
								</Label>
								<Label>
									原因
									<Textarea
										className="mt-1"
										value={reviewForm.reason}
										onChange={(event) =>
											setReviewForm({
												...reviewForm,
												reason: event.target.value,
											})
										}
										maxLength={1024}
									/>
								</Label>
								<div className="flex gap-2">
									<Button
										type="submit"
										disabled={
											!isAdministrator ||
											reviewState.busy ||
											!reviewForm.skillVersionId.trim()
										}
									>
										提交审核
									</Button>
									<Button
										type="button"
										variant="outline"
										disabled={
											reviewState.busy ||
											!reviewForm.skillVersionId.trim() ||
											!publishedVersionIds.has(reviewForm.skillVersionId.trim())
										}
										onClick={() =>
											void run("revoke", setReviewState, async () => {
												const skillVersionId = reviewForm.skillVersionId.trim();
												const result = await actions.revokeVersion(
													skillVersionId,
													idempotencyKey("revoke", skillVersionId),
												);
												return publicationMessage("撤销", result);
											})
										}
									>
										撤销版本
									</Button>
								</div>
								{reviewState.message ? (
									<ActionMessage value={reviewState.message} />
								) : null}
							</form>
						</ManagementCard>

						<ManagementCard
							icon={<CheckCircle2 aria-hidden="true" />}
							title="Agent 配置"
							description="绑定固定版本并读取 pending_sync、synced、failed 与 Applied 状态。"
						>
							<form
								className="mt-4 space-y-3"
								onSubmit={(event) => {
									event.preventDefault();
									void run("binding", setBindingState, async () => {
										const grant = JSON.parse(
											bindingForm.grant,
										) as SkillHubAgentBindingCommandV1["bindings"][number]["grant"];
										await actions.bindVersion(
											bindingForm.agentId.trim(),
											bindingForm.agentVersion.trim(),
											{
												schemaVersion: 1,
												expectedConfigurationRevision: Number(
													bindingForm.revision,
												),
												bindings: [
													{
														skillVersionId: bindingForm.skillVersionId.trim(),
														grant,
													},
												],
											},
											idempotencyKey("binding", bindingForm),
										);
										const status = await actions.readBindings(
											bindingForm.agentId.trim(),
											bindingForm.agentVersion.trim(),
										);
										return bindingMessage(status.bindings);
									});
								}}
							>
								<Field
									label="Agent ID"
									value={bindingForm.agentId}
									onChange={(value) =>
										setBindingForm({ ...bindingForm, agentId: value })
									}
									required
								/>
								<Field
									label="Agent 版本"
									value={bindingForm.agentVersion}
									onChange={(value) =>
										setBindingForm({ ...bindingForm, agentVersion: value })
									}
									required
								/>
								<Field
									label="配置 revision"
									value={bindingForm.revision}
									onChange={(value) =>
										setBindingForm({ ...bindingForm, revision: value })
									}
									type="number"
									required
								/>
								<Field
									label="Skill 版本 ID"
									value={bindingForm.skillVersionId}
									onChange={(value) =>
										setBindingForm({ ...bindingForm, skillVersionId: value })
									}
									required
								/>
								<Label>
									Grant JSON
									<Textarea
										className="mt-1 font-mono text-xs"
										value={bindingForm.grant}
										onChange={(event) =>
											setBindingForm({
												...bindingForm,
												grant: event.target.value,
											})
										}
									/>
								</Label>
								<div className="flex gap-2">
									<Button
										type="submit"
										disabled={
											bindingState.busy ||
											!bindingForm.agentId.trim() ||
											!bindingForm.agentVersion.trim() ||
											!bindingForm.skillVersionId.trim()
										}
									>
										保存绑定
									</Button>
									<Button
										type="button"
										variant="outline"
										disabled={
											bindingState.busy ||
											!bindingForm.agentId.trim() ||
											!bindingForm.agentVersion.trim()
										}
										onClick={() =>
											void run("binding-read", setBindingState, async () => {
												const status = await actions.readBindings(
													bindingForm.agentId.trim(),
													bindingForm.agentVersion.trim(),
												);
												return bindingMessage(status.bindings);
											})
										}
									>
										读取状态
									</Button>
								</div>
								{bindingState.message ? (
									<ActionMessage value={bindingState.message} />
								) : null}
							</form>
						</ManagementCard>
					</div>

					<section
						className="rounded-[14px] border bg-card p-5"
						aria-labelledby="skill-hub-published-heading"
					>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<p className="page-eyebrow">服务端授权 metadata</p>
								<h2
									id="skill-hub-published-heading"
									className="mt-1 font-semibold text-lg"
								>
									已发布版本
								</h2>
							</div>
							<Badge variant="outline">{versions.length} 个版本</Badge>
						</div>
						{versions.length === 0 ? (
							<Empty className="min-h-40">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<PackageOpen aria-hidden="true" />
									</EmptyMedia>
									<EmptyTitle>暂无已发布版本</EmptyTitle>
									<EmptyDescription>
										发布成功的固定版本会显示在这里。
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<ul className="mt-4 grid gap-3" aria-label="已发布 Skill 版本">
								{versions.map((version) => (
									<li
										key={version.skillVersionId}
										className="rounded-[10px] border p-4"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div className="min-w-0">
												<h3 className="break-all font-medium">
													<Link
														className={buttonVariants({ variant: "link" })}
														to="/skills/$skillVersionId"
														params={{ skillVersionId: version.skillVersionId }}
													>
														{version.name}
													</Link>
												</h3>
												<p className="mt-1 break-all text-muted-foreground text-sm">
													版本 {version.version} · {version.skillVersionId}
												</p>
											</div>
											<div className="flex flex-wrap gap-2">
												<Badge variant="secondary">
													{skillHubProviderLabels[version.provider]}
												</Badge>
												<Badge variant="outline">
													{skillHubVisibilityLabels[version.visibility]}
												</Badge>
												<Badge variant="outline">published</Badge>
											</div>
										</div>
										<p className="mt-3 break-all text-muted-foreground text-xs">
											digest: {version.packageDigest}
										</p>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</section>
	);
}

function Field({
	label,
	value,
	onChange,
	required = false,
	type = "text",
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	required?: boolean;
	type?: string;
}) {
	return (
		<Label>
			{label}
			<Input
				className="mt-1"
				type={type}
				value={value}
				required={required}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Label>
	);
}

function ProviderSelect({
	value,
	onChange,
}: {
	value: SkillHubProviderImportRequestV1["provider"];
	onChange: (value: SkillHubProviderImportRequestV1["provider"]) => void;
}) {
	return (
		<Label>
			Provider
			<NativeSelect
				className="mt-1"
				value={value}
				onChange={(event) =>
					onChange(
						event.target.value as SkillHubProviderImportRequestV1["provider"],
					)
				}
			>
				{Object.entries(skillHubProviderLabels).map(([provider, label]) => (
					<NativeSelectOption key={provider} value={provider}>
						{label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Label>
	);
}

function VisibilitySelect({
	value,
	onChange,
}: {
	value: SkillHubPublicationRequestV1["visibility"];
	onChange: (value: SkillHubPublicationRequestV1["visibility"]) => void;
}) {
	return (
		<Label>
			可见范围
			<NativeSelect
				className="mt-1"
				value={value}
				onChange={(event) =>
					onChange(
						event.target.value as SkillHubPublicationRequestV1["visibility"],
					)
				}
			>
				{Object.entries(skillHubVisibilityLabels).map(([visibility, label]) => (
					<NativeSelectOption key={visibility} value={visibility}>
						{label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Label>
	);
}

function ActionMessage({ value }: { value?: string }) {
	return value ? (
		<p role="status" className="text-muted-foreground text-sm">
			{value}
		</p>
	) : null;
}

function ManagementCard({
	icon,
	title,
	description,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section className="rounded-[14px] border bg-card p-5">
			<div className="flex items-start gap-3">
				<div className="text-muted-foreground">{icon}</div>
				<div className="min-w-0">
					<h2 className="font-medium">{title}</h2>
					<p className="mt-2 text-muted-foreground text-sm">{description}</p>
				</div>
			</div>
			{children}
		</section>
	);
}
