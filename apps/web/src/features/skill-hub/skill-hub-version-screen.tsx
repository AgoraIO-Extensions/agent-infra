import { Link } from "@tanstack/react-router";
import { ArrowLeft, Plus, Settings } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadingLine, Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type { SkillHubVersionDetailV1 } from "../../pilot/generated-v2/types.gen.js";
import { formatBytes } from "../conversation/conversation-files.js";
import {
	DirectoryNameText,
	DirectoryReadAlert,
	useDirectoryNames,
} from "../directory-names.js";
import { PageLoadingState } from "../page-loading-state.js";
import type {
	SkillHubDirectoryState,
	SkillHubOwnedVersionsState,
	SkillHubVersionState as SkillHubVersionReadState,
} from "./skill-hub.js";
import {
	type SkillHubVersionState,
	skillHubProviderLabels,
	skillHubVisibilityLabels,
	versionsOfSkill,
} from "./skill-hub-labels.js";
import type {
	installSkillHubVersion,
	revokeSkillHubVersion,
	uninstallSkillHubInstallation,
} from "./skill-hub-management.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
import { SkillHubReadFailure } from "./skill-hub-screen.js";

export type SkillDetailTab = "overview" | "versions";

export type SkillHubVersionActions = {
	install: (
		skillVersionId: string,
		idempotencyKey: string,
	) => ReturnType<typeof installSkillHubVersion>;
	uninstall: (
		installationId: string,
		idempotencyKey: string,
	) => ReturnType<typeof uninstallSkillHubInstallation>;
	revoke: (
		skillVersionId: string,
		idempotencyKey: string,
	) => ReturnType<typeof revokeSkillHubVersion>;
};

type RequestFailure = { status?: number; retryable?: boolean };
/** 页面上的「我的库」状态；409 后尚未回读到安装记录 ID 时 installationId 为空。 */
type LibraryState =
	| { state: "installed"; installationId?: string }
	| { state: "not_installed" };

function requestFailure(error: unknown): RequestFailure {
	return error && typeof error === "object" ? (error as RequestFailure) : {};
}

// 失败文案不含错误码或原始枚举。
function installFailureMessage(error: unknown) {
	const { status, retryable } = requestFailure(error);
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能把这个版本加入我的库。";
	if (status === 404) return "这个版本已不可安装，请回到 Skill Hub 重新选择。";
	if (status === 503 || retryable) return "暂时无法加入我的库，请稍后重试。";
	return "加入我的库失败，请稍后重试。";
}

function uninstallFailureMessage(error: unknown) {
	const { status, retryable } = requestFailure(error);
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能把这个版本移出我的库。";
	if (status === 404 || status === 409)
		return "我的库状态已变化，请刷新后再操作。";
	if (status === 503 || retryable) return "暂时无法移出我的库，请稍后重试。";
	return "移出我的库失败，请稍后重试。";
}

function revokeFailureMessage(error: unknown) {
	const { status, retryable } = requestFailure(error);
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能撤销这个版本。";
	if (status === 409) return "版本状态已变化，请刷新后再操作。";
	if (status === 503 || retryable) return "暂时无法撤销版本，请稍后重试。";
	return "撤销版本失败，请稍后重试。";
}

const resourceKindLabels = {
	script: "脚本",
	reference: "参考资料",
	asset: "资源文件",
	file: "其他文件",
} satisfies Record<
	Extract<
		SkillHubVersionDetailV1["content"],
		{ state: "available" }
	>["resources"][number]["kind"],
	string
>;

type SkillHubVersionScreenProps = {
	state: SkillHubVersionReadState | { kind: "loading" };
	onRetry?: () => void;
	retrying?: boolean;
	/** 同一目录查询：版本列表取同一 skillId 的已发布版本。 */
	catalog: SkillHubDirectoryState | { kind: "loading" };
	/** 本人的全部版本：版本列表据此补上本人审核中、已驳回、已撤销的版本。 */
	ownedVersions?: SkillHubOwnedVersionsState | { kind: "loading" };
	onCatalogChanged?: () => void;
	/** 安装或移出后回读版本详情，「我的库」以服务端结果为准。 */
	onVersionChanged?: () => void;
	tab: SkillDetailTab;
	onTabChange: (tab: SkillDetailTab) => void;
	/** 当前用户的 Skill 项目包含该 skillId 时才是创建者，可以撤销。 */
	owned: boolean;
	actions: SkillHubVersionActions;
};

export function SkillHubVersionScreen(props: SkillHubVersionScreenProps) {
	const { state } = props;
	if (
		state.kind === "loading" ||
		(state.kind === "unavailable" && props.retrying)
	)
		return (
			<PageLoadingState title="Skill 详情" message="正在读取 Skill 版本…" />
		);
	if (state.kind === "unavailable")
		return (
			<section className="skill-page" aria-labelledby="skill-version-heading">
				<BackToHub />
				<header className="page-heading">
					<div>
						<p className="page-eyebrow">Skill Hub</p>
						<h1 id="skill-version-heading">Skill 详情</h1>
					</div>
				</header>
				<SkillHubReadFailure
					retryable={state.retryable}
					reason={state.reason}
					retryTitle="暂时无法读取这个版本"
					retryDescription="已安装和绑定记录仍然保留。"
					deniedText="当前账号没有读取该 Skill 版本的权限。"
					unavailableText="Skill 版本暂时无法访问，请联系管理员。"
					onRetry={props.onRetry}
					retrying={props.retrying}
				/>
			</section>
		);
	// 换版本时重新挂载，安装与撤销的会话内状态不跨版本保留。
	return (
		<ReadyVersion
			key={state.version.skillVersionId}
			{...props}
			version={state.version}
		/>
	);
}

function BackToHub() {
	// exact：/skills 是 /skills/$skillVersionId 的前缀，不让 Link 补 aria-current（N-21）。
	return (
		<Link
			activeOptions={{ exact: true }}
			className={buttonVariants({ variant: "ghost" })}
			to="/skills"
		>
			<ArrowLeft aria-hidden="true" />
			返回 Skill Hub
		</Link>
	);
}

function ReadyVersion({
	version,
	catalog,
	ownedVersions,
	onCatalogChanged,
	onVersionChanged,
	tab,
	onTabChange,
	owned,
	actions,
}: SkillHubVersionScreenProps & {
	version: SkillHubVersionDetailV1;
}) {
	const id = useId();
	const toast = useToast();
	const heading = useRef<HTMLHeadingElement>(null);
	const configureLink = useRef<HTMLAnchorElement>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const keys = useRef(new Map<string, string>());
	const publisher = useDirectoryNames("user", [version.ownerId]);
	const [revoked, setRevoked] = useState(false);
	const state: SkillHubVersionState = revoked ? "revoked" : version.state;
	// 写操作成功后先显示新状态；服务端回读到不同的安装记录时以回读为准。
	const serverLibrary = version.installation;
	const serverKey =
		serverLibrary.state === "installed" ? serverLibrary.installationId : "";
	const [local, setLocal] = useState<{
		basedOn: string;
		value: LibraryState;
	}>();
	const library: LibraryState =
		local && local.basedOn === serverKey ? local.value : serverLibrary;
	// 回读结果与乐观状态的依据不同，说明服务端已给出新事实：丢弃乐观状态，
	// 以后即使回读又回到原值（如在其他页面移出），也只以服务端为准。
	useEffect(() => {
		setLocal((current) =>
			current && current.basedOn !== serverKey ? undefined : current,
		);
	}, [serverKey]);
	const [installing, setInstalling] = useState(false);
	const [removing, setRemoving] = useState(false);
	// 加入失败显示在页头主操作下方，移出失败显示在侧栏「移出我的库」旁。
	const [libraryError, setLibraryError] = useState<{
		action: "install" | "uninstall";
		text: string;
	}>();
	const [revoking, setRevoking] = useState(false);
	const [revokeError, setRevokeError] = useState<string>();
	const [focusTarget, setFocusTarget] = useState<
		"add" | "configure" | "heading"
	>();
	const published = state === "published";
	const installed = library.state === "installed";

	useEffect(() => {
		if (focusTarget === "configure") configureLink.current?.focus();
		if (focusTarget === "add") addButton.current?.focus();
		if (focusTarget === "heading") heading.current?.focus();
		if (focusTarget) setFocusTarget(undefined);
	}, [focusTarget]);

	// 同一操作失败后重试复用同一幂等键，成功后丢弃。
	function keyFor(operation: string) {
		const existing = keys.current.get(operation);
		if (existing) return existing;
		const key = crypto.randomUUID();
		keys.current.set(operation, key);
		return key;
	}

	async function addToLibrary() {
		if (installing || installed || !published) return;
		setInstalling(true);
		setLibraryError(undefined);
		try {
			const result = await actions.install(
				version.skillVersionId,
				keyFor("install"),
			);
			keys.current.delete("install");
			setLocal({
				basedOn: serverKey,
				value: {
					state: "installed",
					installationId: result.installation.installationId,
				},
			});
			toast("固定版本已加入我的库，尚未绑定到 Agent");
			setFocusTarget("configure");
			onVersionChanged?.();
		} catch (error) {
			if (requestFailure(error).status === 409) {
				keys.current.delete("install");
				setLocal({ basedOn: serverKey, value: { state: "installed" } });
				toast("这个版本已在我的库中");
				setFocusTarget("configure");
				onVersionChanged?.();
				return;
			}
			setLibraryError({
				action: "install",
				text: installFailureMessage(error),
			});
		} finally {
			setInstalling(false);
		}
	}

	async function removeFromLibrary() {
		if (
			removing ||
			library.state !== "installed" ||
			library.installationId === undefined
		)
			return;
		const operation = `uninstall:${library.installationId}`;
		setRemoving(true);
		setLibraryError(undefined);
		try {
			await actions.uninstall(library.installationId, keyFor(operation));
			keys.current.delete(operation);
			setLocal({ basedOn: serverKey, value: { state: "not_installed" } });
			toast("已移出我的库");
			setFocusTarget(published ? "add" : "heading");
			onVersionChanged?.();
		} catch (error) {
			setLibraryError({
				action: "uninstall",
				text: uninstallFailureMessage(error),
			});
		} finally {
			setRemoving(false);
		}
	}

	async function revoke() {
		if (revoking || !published) return;
		setRevoking(true);
		setRevokeError(undefined);
		try {
			const result = await actions.revoke(
				version.skillVersionId,
				keyFor("revoke"),
			);
			keys.current.delete("revoke");
			setRevoked(result.version.state === "revoked");
			toast("版本已撤销，新的调用已被阻止");
			setFocusTarget("heading");
			onCatalogChanged?.();
		} catch (error) {
			setRevokeError(revokeFailureMessage(error));
		} finally {
			setRevoking(false);
		}
	}

	// 已发布目录只含已发布版本；本人还能看到自己其他状态的版本。同一版本以本人目录为准。
	const siblings =
		catalog.kind === "ready"
			? versionsOfSkill(
					[
						...new Map(
							[
								...catalog.versions,
								...(ownedVersions?.kind === "ready"
									? ownedVersions.versions
									: []),
								{ ...version, state },
							].map((item) => [item.skillVersionId, item]),
						).values(),
					],
					version.skillId,
				)
			: [];

	return (
		<section className="skill-page" aria-labelledby={`${id}-heading`}>
			<BackToHub />
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">Skill Hub</p>
					<h1 id={`${id}-heading`} ref={heading} tabIndex={-1}>
						{version.name}
					</h1>
				</div>
				{/* 页头只放一个主操作（V-12）；「移出我的库」在侧栏「版本与权限」，加入前后页头高度不变。 */}
				{published || owned ? (
					<div className="skill-actions skill-primary-action">
						{published && installed ? (
							<Link
								ref={configureLink}
								className={buttonVariants()}
								to="/my-agents"
								search={{ tab: "owned" }}
							>
								<Settings aria-hidden="true" />
								配置 Agent 绑定
							</Link>
						) : published ? (
							// 校验与安装进行中是可聚焦的禁用（aria-disabled），焦点留在按钮上；成功后到「配置
							// Agent 绑定」，失败时仍在按钮上（D2-59、#3242 K7-02）。
							<Button
								ref={addButton}
								type="button"
								disabled={installing}
								focusableWhenDisabled
								onClick={() => void addToLibrary()}
							>
								{installing ? (
									<Spinner size="sm" />
								) : (
									<Plus aria-hidden="true" />
								)}
								{installing ? "正在校验包…" : "加入我的库"}
							</Button>
						) : owned ? (
							// 设计页头「编辑新版本」为 outline 文字按钮，不带图标（C2-09）。
							<Link
								className={buttonVariants({ variant: "outline" })}
								to="/skills/manage/new"
								search={{ project: version.skillId }}
							>
								编辑新版本
							</Link>
						) : null}
						{libraryError?.action === "install" ? (
							<Alert tone="danger" role="alert" className="skill-action-error">
								<AlertDescription>{libraryError.text}</AlertDescription>
							</Alert>
						) : null}
					</div>
				) : null}
			</header>
			<DirectoryReadAlert names={[publisher]} className="mb-4" />

			<Tabs
				value={tab}
				onValueChange={(value) => onTabChange(value as SkillDetailTab)}
			>
				<TabsList activateOnFocus aria-label="Skill 详情">
					<TabsTrigger value="overview">用途与内容</TabsTrigger>
					<TabsTrigger value="versions">版本与变更</TabsTrigger>
				</TabsList>
				{/* tabpanel 本身就是左侧卡片（设计 .surface[role=tabpanel]）：键盘焦点环沿卡片 14px 圆角，
				    不再是卡片内层的直角矩形（#3242 K7-04）。只渲染选中的面板，栅格里始终只有一张左栏卡片。 */}
				<div className="skill-grid">
					<TabsContent value="overview" className="skill-surface">
						<section
							className="skill-section"
							aria-labelledby={`${id}-purpose`}
						>
							<h2 id={`${id}-purpose`}>适合什么工作</h2>
							<ul>
								<li>在当前已获授权的 Agent 与会话中使用。</li>
								<li>不会增加模型、文件或 Connection 权限。</li>
								<li>正文和配套资源在发起调用后按需加载。</li>
							</ul>
						</section>
						<SkillContent id={id} content={version.content} />
					</TabsContent>
					<TabsContent value="versions" className="skill-surface">
						<section
							className="skill-section"
							aria-labelledby={`${id}-versions`}
						>
							<h2 id={`${id}-versions`}>固定版本</h2>
							<p>新版本不会自动替换 Agent 当前绑定。</p>
							{catalog.kind === "loading" ? (
								<LoadingLine className="mt-4">正在读取版本列表…</LoadingLine>
							) : catalog.kind === "unavailable" ? (
								<Alert tone="warn" role="status" className="mt-4">
									<AlertDescription>
										版本列表暂时无法读取，当前版本信息不受影响。
									</AlertDescription>
								</Alert>
							) : (
								<div className="skill-version-list">
									{siblings.map((item) => (
										<div className="version-line" key={item.skillVersionId}>
											<div>
												<strong>v{item.version}</strong>{" "}
												<SkillHubStateChip state={item.state} />
											</div>
											{item.skillVersionId === version.skillVersionId ? (
												<Button variant="ghost" type="button" disabled>
													正在查看
												</Button>
											) : (
												<Link
													className={buttonVariants({ variant: "ghost" })}
													to="/skills/$skillVersionId"
													params={{ skillVersionId: item.skillVersionId }}
													search={{ tab: "versions" }}
													aria-label={withObjectName(
														"查看版本",
														`v${item.version}`,
													)}
												>
													查看版本
												</Link>
											)}
										</div>
									))}
								</div>
							)}
						</section>
					</TabsContent>
					<aside
						className="skill-surface skill-summary"
						aria-labelledby={`${id}-summary`}
					>
						<h2 id={`${id}-summary`}>版本与权限</h2>
						<dl className="skill-facts">
							<dt>版本</dt>
							<dd>v{version.version}</dd>
							<dt>发布状态</dt>
							<dd>
								<SkillHubStateChip state={state} />
							</dd>
							<dt>发布者</dt>
							<dd>
								<DirectoryNameText
									name={publisher.resolve(version.ownerId)}
									status={publisher.status}
								/>
							</dd>
							<dt>来源</dt>
							<dd>{skillHubProviderLabels[version.provider]}</dd>
							<dt>可见范围</dt>
							<dd>{skillHubVisibilityLabels[version.visibility]}</dd>
							<dt>我的库</dt>
							<dd>
								{installing
									? "正在校验包…"
									: installed
										? "已在我的库"
										: "尚未安装"}
							</dd>
							<dt>脚本</dt>
							<dd>禁用</dd>
							<dt>网络权限</dt>
							<dd>不会新增</dd>
						</dl>
						<p className="skill-form-hint">
							安装后还不能直接使用。先绑定到 Agent 版本并完成同步。
						</p>
						{revokeError ? (
							<Alert tone="danger" role="alert" className="mt-4">
								<AlertDescription>{revokeError}</AlertDescription>
							</Alert>
						) : null}
						{libraryError?.action === "uninstall" ? (
							<Alert tone="danger" role="alert" className="mt-4">
								<AlertDescription>{libraryError.text}</AlertDescription>
							</Alert>
						) : null}
						{(installed && library.installationId !== undefined) ||
						(owned && published) ? (
							<div className="skill-actions skill-summary-actions">
								{installed && library.installationId !== undefined ? (
									// 移出进行中是可聚焦的禁用；成功后到「加入我的库」（已撤销时到 h1），失败时仍在按钮上。
									<Button
										type="button"
										variant="ghost"
										disabled={removing}
										focusableWhenDisabled
										onClick={() => void removeFromLibrary()}
									>
										{removing ? "正在移出…" : "移出我的库"}
									</Button>
								) : null}
								{owned && published ? (
									<ConfirmDialog
										variant="skill"
										disabled={revoking}
										trigger={
											// 撤销进行中是可聚焦的禁用：确认弹窗关闭后焦点回到这里，不落到 body；
											// 撤销后焦点到 h1（D2-59、#3242 K7-02）。
											<Button
												variant="ghost"
												type="button"
												focusableWhenDisabled={revoking}
											>
												{revoking ? "正在撤销…" : "撤销此版本"}
											</Button>
										}
										title="撤销这个 Skill 版本？"
										subject={{ name: `${version.name} · v${version.version}` }}
										description="阻止新的安装、绑定与调用。已发生的执行及结果继续保留原版本。"
										confirmLabel="确认撤销"
										onConfirm={() => void revoke()}
									/>
								) : null}
							</div>
						) : null}
					</aside>
				</div>
			</Tabs>
		</section>
	);
}

/** SKILL.md 只作为纯文本显示，不解析 Markdown 或 HTML；资源只列清单。审阅弹窗（#3046）共用。 */
export function SkillBody({ body }: { body: string }) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动的正文需要键盘可达。
		<section className="skill-code" tabIndex={0} aria-label="SKILL.md 正文">
			<pre>{body}</pre>
		</section>
	);
}

function SkillContent({
	id,
	content,
}: {
	id: string;
	content: SkillHubVersionDetailV1["content"];
}) {
	if (content.state === "unavailable")
		return (
			<section className="skill-section" aria-labelledby={`${id}-body`}>
				<h2 id={`${id}-body`}>Skill 正文</h2>
				<p>正文与配套资源暂时无法读取，版本信息不受影响。</p>
			</section>
		);
	return (
		<>
			<section className="skill-section" aria-labelledby={`${id}-body`}>
				<h2 id={`${id}-body`}>Skill 正文</h2>
				{content.body ? (
					<SkillBody body={content.body} />
				) : (
					<p>SKILL.md 没有正文。</p>
				)}
				{content.bodyTruncated ? (
					<p>正文较长，这里只显示开头部分；调用时会按需加载完整内容。</p>
				) : null}
			</section>
			<section className="skill-section" aria-labelledby={`${id}-resources`}>
				<h2 id={`${id}-resources`}>配套资源</h2>
				{content.resources.length ? (
					<ul className="skill-resources">
						{content.resources.map((resource) => (
							<li key={resource.path}>
								<span className="quiet-pill skill-resource-path">
									{resource.path}
								</span>
								<span className="skill-resource-meta">
									{resourceKindLabels[resource.kind]} ·{" "}
									{formatBytes(resource.sizeBytes)}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p>这个版本没有配套资源。</p>
				)}
			</section>
		</>
	);
}
