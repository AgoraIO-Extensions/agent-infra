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
import { PageLoadingState } from "../page-loading-state.js";
import type {
	SkillHubDirectoryState,
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
} from "./skill-hub-management.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
import { SkillHubReadFailure } from "./skill-hub-screen.js";

export type SkillDetailTab = "overview" | "versions";

export type SkillHubVersionActions = {
	install: (
		skillVersionId: string,
		idempotencyKey: string,
	) => ReturnType<typeof installSkillHubVersion>;
	revoke: (
		skillVersionId: string,
		idempotencyKey: string,
	) => ReturnType<typeof revokeSkillHubVersion>;
};

type RequestFailure = { status?: number; retryable?: boolean };

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

function revokeFailureMessage(error: unknown) {
	const { status, retryable } = requestFailure(error);
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能撤销这个版本。";
	if (status === 409) return "版本状态已变化，请刷新后再操作。";
	if (status === 503 || retryable) return "暂时无法撤销版本，请稍后重试。";
	return "撤销版本失败，请稍后重试。";
}

type SkillHubVersionScreenProps = {
	state: SkillHubVersionReadState | { kind: "loading" };
	onRetry?: () => void;
	retrying?: boolean;
	/** 同一目录查询：版本列表取同一 skillId 的已发布版本。 */
	catalog: SkillHubDirectoryState | { kind: "loading" };
	onCatalogChanged?: () => void;
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
	return (
		<Link className={buttonVariants({ variant: "ghost" })} to="/skills">
			<ArrowLeft aria-hidden="true" />
			返回 Skill Hub
		</Link>
	);
}

function ReadyVersion({
	version,
	catalog,
	onCatalogChanged,
	tab,
	onTabChange,
	owned,
	actions,
}: SkillHubVersionScreenProps & {
	version: Extract<SkillHubVersionReadState, { kind: "ready" }>["version"];
}) {
	const id = useId();
	const toast = useToast();
	const heading = useRef<HTMLHeadingElement>(null);
	const configureLink = useRef<HTMLAnchorElement>(null);
	const keys = useRef(new Map<string, string>());
	const [state, setState] = useState<SkillHubVersionState>(version.state);
	const [install, setInstall] = useState<"idle" | "pending" | "installed">(
		"idle",
	);
	const [installError, setInstallError] = useState<string>();
	const [revoking, setRevoking] = useState(false);
	const [revokeError, setRevokeError] = useState<string>();
	const [focusTarget, setFocusTarget] = useState<"configure" | "heading">();
	const published = state === "published";

	useEffect(() => {
		if (focusTarget === "configure") configureLink.current?.focus();
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
		if (install !== "idle" || !published) return;
		setInstall("pending");
		setInstallError(undefined);
		try {
			await actions.install(version.skillVersionId, keyFor("install"));
			keys.current.delete("install");
			setInstall("installed");
			toast("固定版本已加入我的库，尚未绑定到 Agent");
			setFocusTarget("configure");
		} catch (error) {
			if (requestFailure(error).status === 409) {
				keys.current.delete("install");
				setInstall("installed");
				toast("这个版本已在我的库中");
				setFocusTarget("configure");
				return;
			}
			setInstall("idle");
			setInstallError(installFailureMessage(error));
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
			setState(result.version.state);
			toast("版本已撤销，新的调用已被阻止");
			setFocusTarget("heading");
			onCatalogChanged?.();
		} catch (error) {
			setRevokeError(revokeFailureMessage(error));
		} finally {
			setRevoking(false);
		}
	}

	const siblings =
		catalog.kind === "ready"
			? versionsOfSkill(
					[
						...catalog.versions.filter(
							(item) => item.skillVersionId !== version.skillVersionId,
						),
						{ ...version, state },
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
				{published ? (
					<div className="skill-actions skill-primary-action">
						{install === "installed" ? (
							<Link
								ref={configureLink}
								className={buttonVariants()}
								to="/my-agents"
							>
								<Settings aria-hidden="true" />
								配置 Agent 绑定
							</Link>
						) : (
							<Button
								type="button"
								disabled={install === "pending"}
								onClick={() => void addToLibrary()}
							>
								{install === "pending" ? (
									<Spinner size="sm" />
								) : (
									<Plus aria-hidden="true" />
								)}
								{install === "pending" ? "正在校验包…" : "加入我的库"}
							</Button>
						)}
						{installError ? (
							<Alert tone="danger" role="alert" className="skill-action-error">
								<AlertDescription>{installError}</AlertDescription>
							</Alert>
						) : null}
					</div>
				) : null}
			</header>

			<Tabs
				value={tab}
				onValueChange={(value) => onTabChange(value as SkillDetailTab)}
			>
				<TabsList activateOnFocus aria-label="Skill 详情">
					<TabsTrigger value="overview">用途与内容</TabsTrigger>
					<TabsTrigger value="versions">版本与变更</TabsTrigger>
				</TabsList>
				<div className="skill-grid">
					<div className="skill-surface">
						<TabsContent value="overview">
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
						</TabsContent>
						<TabsContent value="versions">
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
					</div>
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
							<dt>来源</dt>
							<dd>{skillHubProviderLabels[version.provider]}</dd>
							<dt>可见范围</dt>
							<dd>{skillHubVisibilityLabels[version.visibility]}</dd>
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
						{owned && published ? (
							<div className="skill-actions skill-summary-actions">
								<ConfirmDialog
									disabled={revoking}
									trigger={
										<Button variant="ghost" type="button">
											{revoking ? "正在撤销…" : "撤销此版本"}
										</Button>
									}
									title="撤销这个 Skill 版本？"
									subject={{ name: `${version.name} · v${version.version}` }}
									description="阻止新的安装、绑定与调用。已发生的执行及结果继续保留原版本。"
									confirmLabel="确认撤销"
									onConfirm={() => void revoke()}
								/>
							</div>
						) : null}
					</aside>
				</div>
			</Tabs>
		</section>
	);
}
