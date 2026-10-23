import { Link } from "@tanstack/react-router";
import { ArrowLeft, Layers, Plus } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type {
	SkillHubOwnedVersionV1,
	SkillHubProjectV1,
	SkillHubProviderImportRequestV1,
	SkillHubPublicationResponseV1,
} from "../../pilot/generated-v2/types.gen.js";
import type { CollectionReadUnavailable } from "../collection-read-failure.js";
import type {
	SkillHubInstallationsState,
	SkillHubOwnedVersionsState,
} from "./skill-hub.js";
import { MyInstallationsSection } from "./skill-hub-installations-section.js";
import {
	latestVersionPerSkill,
	skillHubProviderLabels,
	skillHubVersionStateLabels,
	skillHubVisibilityLabels,
} from "./skill-hub-labels.js";
import {
	createSkillHubProject,
	importSkillHubVersion,
	updateSkillHubProject,
} from "./skill-hub-management.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
import {
	SkillHubEmpty,
	SkillHubLoading,
	SkillHubReadFailure,
} from "./skill-hub-screen.js";
import {
	SkillEditorLayout,
	type SkillProjectContentActions,
	SkillProjectContentEditor,
	type SkillProjectContentState,
} from "./skill-project-content-editor.js";

/** 契约 packageName：小写字母或数字开头，最长 63 位。 */
export const skillPackageNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
// 设计 import-source：拒绝 latest、HEAD、通配符与分支名这类会漂移的引用。
const floatingReference = /latest|HEAD|\*|:main$|@main$/i;
// 导入只支持受控的外部来源；平台预置、我的库与内部市场不是导入来源。
const importProviders = ["clawhub", "skillhub", "npx", "github"] as const;

export type SkillHubProjectsState =
	| { kind: "loading" }
	| { kind: "ready"; items: SkillHubProjectV1[] }
	| CollectionReadUnavailable;

type RequestFailure = { status?: number; retryable?: boolean };

// 写操作失败文案：不显示错误码与原始枚举。
export function skillWriteFailureMessage(error: unknown) {
	const { status, retryable } =
		error && typeof error === "object" ? (error as RequestFailure) : {};
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能执行这个操作。";
	if (status === 409) return "名称或版本已被使用，或状态已变化，请刷新后重试。";
	if (status === 503 || retryable) return "Skill Hub 暂时不可用，可稍后重试。";
	return "请求未完成，请检查输入后重试。";
}

function importResultText(result: SkillHubPublicationResponseV1) {
	const { version, replayed } = result;
	const replay = replayed ? "这是重复提交，已返回第一次的结果。" : "";
	const text = {
		published: `v${version.version} 已发布，可以在 Skill Hub 中查看。`,
		pending_review: `v${version.version} 已提交审核，审核通过前不能安装。`,
		rejected: `v${version.version} 未通过审核${version.reviewReason ? `：${version.reviewReason}` : "。"}`,
		revoked: `v${version.version} 已撤销。`,
	}[version.state];
	return `${text}${replay}`;
}

export function MySkillsScreen({
	projects,
	versions,
	installations,
	onRetry,
	onRelogin,
	retrying = false,
	onInstallationsRetry,
	installationsRetrying = false,
	onInstallationsChanged,
	uninstall,
}: {
	projects: SkillHubProjectsState;
	/** 本人的全部版本（含审核中、已驳回、已撤销）。 */
	versions: SkillHubOwnedVersionsState | { kind: "loading" };
	/** 本人在我的库中的安装（#2953）。 */
	installations: SkillHubInstallationsState | { kind: "loading" };
	onRetry?: () => void;
	/** 任一分区读取 401 时的「重新登录」：确认会话仍有效后重读失败的分区（W-03）。 */
	onRelogin?: () => void;
	retrying?: boolean;
	onInstallationsRetry?: () => void;
	installationsRetrying?: boolean;
	onInstallationsChanged?: () => void;
	uninstall?: (
		installationId: string,
		idempotencyKey: string,
	) => Promise<unknown>;
}) {
	const id = useId();
	// 每个项目取本人版本号最高的版本，状态按服务端回读显示。
	const latest =
		versions.kind === "ready" ? latestVersionPerSkill(versions.versions) : [];
	return (
		<section className="skill-page" aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">我的管理 / 我的 Skill</p>
					{/* tabIndex=-1：分区「重新读取」「重新登录」恢复后焦点落在这里（D2-59）。 */}
					<h1 id={`${id}-heading`} tabIndex={-1}>
						我的 Skill
					</h1>
					<p>管理自己创建的 Skill 和已安装版本。</p>
				</div>
				<div className="skill-actions">
					<Link className={buttonVariants()} to="/skills/manage/new">
						<Plus aria-hidden="true" />
						创建或导入
					</Link>
				</div>
			</header>

			{/* 设计 #my-skills：先「已安装」（区头带「Agent 绑定」），再「我创建的」（V-15）。 */}
			<MyInstallationsSection
				installations={installations}
				onRetry={onInstallationsRetry}
				onRelogin={onRelogin}
				retrying={installationsRetrying}
				onChanged={onInstallationsChanged}
				{...(uninstall ? { uninstall } : {})}
			/>

			<section className="skill-section-block" aria-labelledby={`${id}-owned`}>
				<div className="section-heading">
					<div>
						<h2 id={`${id}-owned`}>我创建的</h2>
						<p>新版本独立保存，旧版本和已有执行记录继续保留</p>
					</div>
				</div>
				{projects.kind === "loading" ||
				(projects.kind === "unavailable" && retrying) ? (
					<SkillHubLoading>正在读取我的 Skill…</SkillHubLoading>
				) : projects.kind === "unavailable" ? (
					<SkillHubReadFailure
						retryable={projects.retryable}
						reason={projects.reason}
						retryTitle="暂时无法读取我的 Skill"
						retryDescription="已发布的版本和 Agent 绑定不受影响。"
						deniedText="当前账号没有管理 Skill 项目的权限。"
						unavailableText="Skill 项目暂时无法访问，请联系管理员。"
						onRetry={onRetry}
						onRelogin={onRelogin}
						retrying={retrying}
						// 与「已安装」同时失败时按钮仍可区分（#3292 N9-3-05）。
						objectName="我创建的"
					/>
				) : projects.items.length === 0 ? (
					<SkillHubEmpty
						title="还没有创建 Skill"
						description="创建项目，或从固定来源导入一个版本。"
						action={
							<Link
								className={buttonVariants({ variant: "outline" })}
								to="/skills/manage/new"
							>
								创建或导入
							</Link>
						}
					/>
				) : (
					<>
						{versions.kind === "unavailable" ? (
							<Alert tone="warn" role="status" className="mb-4">
								<AlertDescription>
									版本状态暂时无法读取，项目列表不受影响。
								</AlertDescription>
							</Alert>
						) : null}
						<div className="skill-surface">
							{projects.items.map((project) => (
								<OwnedSkillRow
									key={project.projectId}
									project={project}
									versions={versions.kind}
									latest={latest.find(
										(version) => version.skillId === project.projectId,
									)}
								/>
							))}
						</div>
					</>
				)}
			</section>
		</section>
	);
}

function OwnedSkillRow({
	project,
	versions,
	latest,
}: {
	project: SkillHubProjectV1;
	versions: "loading" | "ready" | "unavailable";
	/** 本人版本号最高的版本，可能处于任一状态。 */
	latest?: SkillHubOwnedVersionV1;
}) {
	const disabled = project.status === "disabled";
	return (
		<article className="skill-row">
			<span className="skill-mark" aria-hidden="true">
				<Layers />
			</span>
			<div className="skill-row-copy">
				<h3>{project.name}</h3>
				<div className="skill-row-badges">
					{disabled ? (
						<Badge tone="red">已停用</Badge>
					) : latest ? (
						<SkillHubStateChip state={latest.state} />
					) : versions === "ready" ? (
						<Badge tone="gray">暂无版本</Badge>
					) : null}
				</div>
			</div>
			<div className="skill-row-meta">
				{latest ? (
					<>
						<strong>v{latest.version}</strong>
						{skillHubVisibilityLabels[latest.visibility]}
					</>
				) : versions === "loading" ? (
					"正在读取版本…"
				) : versions === "unavailable" ? (
					"版本暂时无法读取"
				) : (
					"尚未提交版本"
				)}
			</div>
			<div className="skill-actions">
				<Link
					className={buttonVariants({ variant: "ghost" })}
					to="/skills/manage/new"
					search={{ project: project.projectId }}
					aria-label={withObjectName("编辑新版本", project.name)}
				>
					编辑新版本
				</Link>
				{latest ? (
					<Link
						className={buttonVariants({ variant: "ghost" })}
						to="/skills/$skillVersionId"
						params={{ skillVersionId: latest.skillVersionId }}
						aria-label={withObjectName("详情", project.name)}
					>
						详情
					</Link>
				) : null}
			</div>
		</article>
	);
}

export type SkillEditorActions = {
	createProject: typeof createSkillHubProject;
	updateProject: typeof updateSkillHubProject;
	importVersion: typeof importSkillHubVersion;
};

const defaultEditorActions: SkillEditorActions = {
	createProject: createSkillHubProject,
	updateProject: updateSkillHubProject,
	importVersion: importSkillHubVersion,
};

type Feedback = { tone: "status" | "alert"; text: string };

function createdFeedback(name: string): Feedback {
	return {
		tone: "status",
		text: `Skill 项目已创建：${name}。可以继续编辑内容并发布，或导入第一个版本。`,
	};
}

export function SkillEditorScreen({
	project,
	projectMissing = false,
	createdName,
	actions = defaultEditorActions,
	onProjectsChanged,
	onProjectCreated,
	content = { kind: "loading" },
	onContentRetry,
	onContentRelogin,
	contentRetrying = false,
	contentActions,
	onPublished,
}: {
	/** 从「编辑新版本」进入时的项目；新建时为空。 */
	project?: SkillHubProjectV1;
	/** 地址里的项目不在当前用户的项目列表中。 */
	projectMissing?: boolean;
	/**
	 * 刚在新建页创建、随后进入的项目名称：进入项目时编辑器按项目重新挂载，由这里保留就地反馈，
	 * 并把焦点交给 SKILL.md 文本框（#3269 N8-3-04）。
	 */
	createdName?: string;
	actions?: SkillEditorActions;
	onProjectsChanged?: () => void;
	/** 新建项目后进入该项目，继续编辑内容并发布。 */
	onProjectCreated?: (projectId: string, name: string) => void;
	/** 已有项目的当前内容（#2906）。 */
	content?: SkillProjectContentState;
	onContentRetry?: () => unknown;
	/** 项目内容读取 401 时的「重新登录」。 */
	onContentRelogin?: () => void;
	contentRetrying?: boolean;
	contentActions?: SkillProjectContentActions;
	onPublished?: () => void;
}) {
	const id = useId();
	const toast = useToast();
	const operationKeys = useRef(
		new Map<string, { fingerprint: string; key: string }>(),
	);
	const [projectName, setProjectName] = useState(project?.name ?? "");
	const [projectStatus, setProjectStatus] = useState<"active" | "disabled">(
		project?.status ?? "active",
	);
	const [projectError, setProjectError] = useState("");
	const [projectFeedback, setProjectFeedback] = useState<Feedback | undefined>(
		() => (project && createdName ? createdFeedback(createdName) : undefined),
	);
	const [projectBusy, setProjectBusy] = useState(false);
	const [importForm, setImportForm] = useState({
		name: project?.name ?? "",
		provider: "github" as SkillHubProviderImportRequestV1["provider"],
		version: "",
	});
	const [importErrors, setImportErrors] = useState<{
		name?: string;
		version?: string;
	}>({});
	const [importFeedback, setImportFeedback] = useState<Feedback>();
	const [importResult, setImportResult] =
		useState<SkillHubPublicationResponseV1>();
	const [importBusy, setImportBusy] = useState(false);
	const projectInput = useRef<HTMLInputElement>(null);
	const importNameInput = useRef<HTMLInputElement>(null);
	const importVersionInput = useRef<HTMLInputElement>(null);
	// 创建项目后进入该项目（D2-59、K7-02）：新建页的「创建项目」随编辑器重新挂载卸载，挂载时焦点先放
	// 「项目信息」标题，内容读到后交给 SKILL.md 文本框（导出稿 create-project），不落到 body；用户已
	// 把焦点移到别处时不抢。
	const projectHeading = useRef<HTMLHeadingElement>(null);
	const focusAfterCreate = useRef(Boolean(project && createdName));
	useLayoutEffect(() => {
		if (!focusAfterCreate.current) return;
		const active = document.activeElement;
		if (!active || active === document.body) projectHeading.current?.focus();
	}, []);
	const consumeCreatedFocus = useCallback(() => {
		if (!focusAfterCreate.current) return false;
		focusAfterCreate.current = false;
		const active = document.activeElement;
		return (
			!active || active === document.body || active === projectHeading.current
		);
	}, []);

	// 同一写操作在输入不变时重试复用幂等键；成功后丢弃。
	function idempotencyKey(scope: string, input: unknown) {
		const fingerprint = JSON.stringify(input);
		const previous = operationKeys.current.get(scope);
		if (previous?.fingerprint === fingerprint) return previous.key;
		const key = crypto.randomUUID();
		operationKeys.current.set(scope, { fingerprint, key });
		return key;
	}

	async function submitProject(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (projectBusy) return;
		const name = projectName.trim();
		if (!skillPackageNamePattern.test(name)) {
			setProjectError("请填写 1–63 位小写字母、数字、点、短横线或下划线。");
			projectInput.current?.focus();
			return;
		}
		setProjectError("");
		setProjectBusy(true);
		setProjectFeedback(undefined);
		const scope = project ? "project-update" : "project-create";
		try {
			if (project) {
				const body = {
					schemaVersion: 1 as const,
					name,
					status: projectStatus,
				};
				const result = await actions.updateProject(
					project.projectId,
					body,
					idempotencyKey(scope, { projectId: project.projectId, body }),
				);
				const text =
					result.status === "disabled"
						? "Skill 项目已停用"
						: "Skill 项目已保存";
				setProjectFeedback({
					tone: "status",
					text: `${text}：${result.name}。`,
				});
				toast(text);
			} else {
				const body = { schemaVersion: 1 as const, name };
				const result = await actions.createProject(
					body,
					idempotencyKey(scope, body),
				);
				setProjectFeedback(createdFeedback(result.name));
				setImportForm((current) => ({ ...current, name: result.name }));
				toast("Skill 项目已创建");
				onProjectCreated?.(result.projectId, result.name);
			}
			operationKeys.current.delete(scope);
			onProjectsChanged?.();
		} catch (error) {
			setProjectFeedback({
				tone: "alert",
				text: skillWriteFailureMessage(error),
			});
		} finally {
			setProjectBusy(false);
		}
	}

	async function submitImport(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (importBusy) return;
		const name = importForm.name.trim();
		const version = importForm.version.trim();
		const errors: typeof importErrors = {};
		if (!skillPackageNamePattern.test(name))
			errors.name = "请填写 1–63 位小写字母、数字、点、短横线或下划线。";
		if (!version || floatingReference.test(version))
			errors.version = "请填写可核验的固定版本引用。";
		setImportErrors(errors);
		if (errors.name) {
			importNameInput.current?.focus();
			return;
		}
		if (errors.version) {
			importVersionInput.current?.focus();
			return;
		}
		setImportBusy(true);
		setImportFeedback(undefined);
		setImportResult(undefined);
		const body = {
			schemaVersion: 1 as const,
			name,
			provider: importForm.provider,
			version,
		};
		try {
			const result = await actions.importVersion(
				body,
				idempotencyKey("provider-import", body),
			);
			operationKeys.current.delete("provider-import");
			setImportResult(result);
			setImportFeedback({ tone: "status", text: importResultText(result) });
			setImportForm((current) => ({ ...current, version: "" }));
			toast(
				result.version.state === "published"
					? "固定版本已发布"
					: result.version.state === "pending_review"
						? "已提交审核，尚未进入可用目录"
						: `导入结果：${skillHubVersionStateLabels[result.version.state]}`,
			);
			onProjectsChanged?.();
		} catch (error) {
			setImportFeedback({
				tone: "alert",
				text: skillWriteFailureMessage(error),
			});
		} finally {
			setImportBusy(false);
		}
	}

	const projectSection = (
		<FormSection
			headingRef={projectHeading}
			title={project ? "项目信息" : "Skill 项目"}
			description={
				project
					? "修改包名称或停用项目；已发布的版本和执行记录保持不变。"
					: "项目是版本的归属；包名称会作为导入与发布的名称。"
			}
		>
			<form className="skill-editor-form" onSubmit={submitProject} noValidate>
				<div className="skill-editor-grid">
					<Field>
						<Label htmlFor={`${id}-project-name`}>包名称</Label>
						<Input
							ref={projectInput}
							id={`${id}-project-name`}
							value={projectName}
							maxLength={63}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={projectError ? "true" : undefined}
							aria-describedby={`${id}-project-name-help${projectError ? ` ${id}-project-name-error` : ""}`}
							onChange={(event) => {
								setProjectName(event.target.value);
								setProjectError("");
							}}
						/>
						<p id={`${id}-project-name-help`} className="skill-field-help">
							小写字母、数字、点、短横线和下划线
						</p>
						{projectError ? (
							<FieldErrorText id={`${id}-project-name-error`}>
								{projectError}
							</FieldErrorText>
						) : null}
					</Field>
					{project ? (
						<Field>
							<Label htmlFor={`${id}-project-status`}>项目状态</Label>
							<NativeSelect
								id={`${id}-project-status`}
								value={projectStatus}
								onChange={(event) =>
									setProjectStatus(event.target.value as "active" | "disabled")
								}
							>
								<NativeSelectOption value="active">启用</NativeSelectOption>
								<NativeSelectOption value="disabled">停用</NativeSelectOption>
							</NativeSelect>
						</Field>
					) : null}
				</div>
				<div className="skill-actions skill-form-actions">
					<Button type="submit" disabled={projectBusy} focusableWhenDisabled>
						{projectBusy ? "正在保存…" : project ? "保存项目" : "创建项目"}
					</Button>
				</div>
				<FeedbackText feedback={projectFeedback} />
			</form>
		</FormSection>
	);
	const importSection = (
		<FormSection
			title="导入固定来源"
			description="来源由平台提供，外部包需完成检查与审核。"
		>
			<form className="skill-editor-form" onSubmit={submitImport} noValidate>
				<div className="skill-editor-grid">
					<Field>
						<Label htmlFor={`${id}-import-provider`}>来源</Label>
						<NativeSelect
							id={`${id}-import-provider`}
							value={importForm.provider}
							onChange={(event) =>
								setImportForm({
									...importForm,
									provider: event.target
										.value as SkillHubProviderImportRequestV1["provider"],
								})
							}
						>
							{importProviders.map((provider) => (
								<NativeSelectOption key={provider} value={provider}>
									{skillHubProviderLabels[provider]}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						{/* 与项目的「包名称」区分，同一页面不出现同名控件。 */}
						<Label htmlFor={`${id}-import-name`}>导入包名称</Label>
						<Input
							ref={importNameInput}
							id={`${id}-import-name`}
							value={importForm.name}
							maxLength={63}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={importErrors.name ? "true" : undefined}
							aria-describedby={
								importErrors.name ? `${id}-import-name-error` : undefined
							}
							onChange={(event) => {
								setImportForm({ ...importForm, name: event.target.value });
								setImportErrors({ ...importErrors, name: undefined });
							}}
						/>
						{importErrors.name ? (
							<FieldErrorText id={`${id}-import-name-error`}>
								{importErrors.name}
							</FieldErrorText>
						) : null}
					</Field>
					<Field className="skill-editor-full">
						<Label htmlFor={`${id}-import-version`}>固定版本引用</Label>
						<Input
							ref={importVersionInput}
							id={`${id}-import-version`}
							value={importForm.version}
							maxLength={256}
							autoComplete="off"
							spellCheck={false}
							placeholder="包名称与固定版本，不使用 latest"
							aria-invalid={importErrors.version ? "true" : undefined}
							aria-describedby={
								importErrors.version ? `${id}-import-version-error` : undefined
							}
							onChange={(event) => {
								setImportForm({
									...importForm,
									version: event.target.value,
								});
								setImportErrors({ ...importErrors, version: undefined });
							}}
						/>
						{importErrors.version ? (
							<FieldErrorText id={`${id}-import-version-error`}>
								{importErrors.version}
							</FieldErrorText>
						) : null}
					</Field>
				</div>
				<div className="skill-actions skill-form-actions">
					<Button
						type="submit"
						variant="outline"
						disabled={importBusy}
						focusableWhenDisabled
					>
						{importBusy ? "正在导入…" : "导入为待检查草稿"}
					</Button>
				</div>
				<FeedbackText feedback={importFeedback}>
					{importResult ? (
						<SkillHubStateChip state={importResult.version.state} />
					) : null}
				</FeedbackText>
			</form>
		</FormSection>
	);
	// 设计右栏 .notice：静态说明，不设 role，也不带图标。
	const permissionNotice = (
		<Alert tone="info" icon={null} className="skill-editor-section">
			<AlertTitle>权限不会扩大</AlertTitle>
			<AlertDescription>
				脚本保持禁用，Skill 只消费已授予 Agent 的文件、工具与 Connection 权限。
			</AlertDescription>
		</Alert>
	);

	return (
		<section className="skill-page" aria-labelledby={`${id}-heading`}>
			{/* exact：返回链接不是当前页，不让 Link 按前缀补 aria-current（N-21）。 */}
			<Link
				activeOptions={{ exact: true }}
				className={buttonVariants({ variant: "ghost" })}
				to="/skills/manage"
			>
				<ArrowLeft aria-hidden="true" />
				返回我的 Skill
			</Link>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">我的管理 / 创建 Skill</p>
					{/* tabIndex=-1：项目内容「重新读取」「重新登录」恢复后焦点落在这里（D2-59）。 */}
					<h1 id={`${id}-heading`} tabIndex={-1}>
						创建与发布 Skill
					</h1>
					<p>填写说明和发布范围。发布后版本固定，修改时创建新版本。</p>
				</div>
			</header>

			{projectMissing ? (
				<Alert tone="warn" role="status" className="mb-4">
					<AlertTitle>找不到这个 Skill 项目</AlertTitle>
					<AlertDescription>
						它可能已被删除，或不属于当前账号。可以新建项目，或返回我的 Skill
						重新选择。
					</AlertDescription>
				</Alert>
			) : null}

			{project ? (
				<SkillProjectContentEditor
					project={project}
					content={content}
					onRetry={onContentRetry}
					onRelogin={onContentRelogin}
					retrying={contentRetrying}
					onPublished={onPublished}
					consumeInitialFocus={consumeCreatedFocus}
					{...(contentActions ? { actions: contentActions } : {})}
					before={projectSection}
					after={importSection}
					notice={permissionNotice}
				/>
			) : (
				// 新建时先创建项目：项目内容是该项目的草稿（Spec §11.6），创建后才出现内容与发布。
				<SkillEditorLayout
					main={
						<>
							{projectSection}
							{importSection}
						</>
					}
					aside={
						<>
							<p className="skill-form-hint">
								创建 Skill 项目后，可以编辑
								SKILL.md，并在这里选择版本与发布范围。
							</p>
							{permissionNotice}
						</>
					}
				/>
			)}
		</section>
	);
}

/** 设计 .field-error：12px --danger-ink，字段下方就地提示。 */
export function FieldErrorText({
	id,
	children,
}: {
	id: string;
	children: string;
}) {
	return (
		<Alert
			id={id}
			tone="danger"
			role="alert"
			icon={null}
			className="skill-field-error"
		>
			{children}
		</Alert>
	);
}

function FeedbackText({
	feedback,
	children,
}: {
	feedback?: Feedback;
	children?: ReactNode;
}) {
	if (!feedback) return null;
	return (
		<Alert
			tone={feedback.tone === "alert" ? "danger" : "info"}
			role={feedback.tone}
			className="mt-4"
		>
			<AlertDescription>{feedback.text}</AlertDescription>
			{children ? <div className="mt-2">{children}</div> : null}
		</Alert>
	);
}
