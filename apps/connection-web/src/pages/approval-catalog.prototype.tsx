// Throwaway UI prototype for Issue #908. Three variants on the existing approval route.
import {
	ArrowLeft,
	ArrowRight,
	Bell,
	BookOpen,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	FileText,
	GitBranch,
	KeyRound,
	ListChecks,
	Plus,
	Search,
	ShieldCheck,
	UsersRound,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./approval-catalog.prototype.css";

type Variant = "A" | "B" | "C";
type CatalogKind = "profiles" | "disclaimers";
type ProfileKey = "read" | "write";
type EditorKind = "profile" | "disclaimer" | null;

const variants: { key: Variant; name: string }[] = [
	{ key: "A", name: "目录与策略分栏" },
	{ key: "B", name: "策略检查器" },
	{ key: "C", name: "目录工作台" },
];

const readActions = [
	"github.get_current_user",
	"github.list_my_repositories",
	"github.list_branches",
	"github.get_branch",
	"github.get_repository",
	"github.list_commits",
	"github.get_commit",
	"github.compare_commits",
	"github.list_repository_issues",
	"github.get_issue",
	"github.list_pull_requests",
	"github.get_pull_request",
	"github.list_pull_request_files",
	"github.list_issue_comments",
];

const writeActions = [
	"github.create_issue",
	"github.update_issue",
	"github.add_issue_labels",
	"github.remove_issue_label",
	"github.add_issue_assignees",
	"github.remove_issue_assignees",
	"github.create_issue_comment",
	"github.update_issue_comment",
	"github.create_pull_request",
	"github.update_pull_request",
	"github.request_pull_request_reviewers",
	"github.create_pull_request_review_comment",
	"github.reply_pull_request_review_comment",
];
const exampleActions = [...readActions, ...writeActions];

const profiles = {
	read: { name: "GitHub 只读", reads: 78, writes: 0 },
	write: { name: "GitHub 协作写入", reads: 78, writes: 13 },
};

const globalText =
	"我确认仅为已说明的工作目的申请 Connection，并按最小必要原则使用获批能力。连接后，授权范围内的操作可能读取外部账号数据或修改外部系统内容；操作结果、时间及责任人会用于审计。不得将连接用于无关业务、访问未经授权的数据或分享账号凭证。审批通过不代替外部平台授权；资格到期、撤销或发生权限变化时，使用权可能被暂停。";
const githubText =
	"我确认所选 GitHub 能力包的具体 READ/WRITE 清单。只读能力可能访问我有权限查看的仓库、代码、Issue 和 Pull Request 信息；协作写入能力还可能创建或修改 Issue、Pull Request、评论、标签及指派。执行写入前，我会核对目标仓库与内容，并对通过本人连接发起的操作负责。不得提交密钥、个人敏感信息或未获准披露的公司资料。";

export function ApprovalCatalogPrototype() {
	const fromUrl = new URLSearchParams(location.search).get("variant");
	const [variant, setVariant] = useState<Variant>(
		fromUrl === "B" || fromUrl === "C" ? fromUrl : "A",
	);
	const [area, setArea] = useState<"policy" | "catalog">("policy");
	const [kind, setKind] = useState<CatalogKind>("profiles");
	const [profile, setProfile] = useState<ProfileKey>("write");
	const [provider, setProvider] = useState("GitHub");
	const [selectedDisclaimer, setSelectedDisclaimer] = useState("github");
	const [includeGithub, setIncludeGithub] = useState(true);
	const [inspectorOpen, setInspectorOpen] = useState(true);
	const [editorKind, setEditorKind] = useState<EditorKind>(null);
	const [editorMode, setEditorMode] = useState<"new" | "copy">("new");
	const [copyName, setCopyName] = useState("");
	const [copyActions, setCopyActions] = useState<string[]>([]);
	const [actionQuery, setActionQuery] = useState("");
	const [editorProvider, setEditorProvider] = useState("GitHub");
	const [disclaimerScope, setDisclaimerScope] = useState("GLOBAL");
	const [copyText, setCopyText] = useState("");
	const [notice, setNotice] = useState("");
	const [draftSummary, setDraftSummary] = useState<{
		kind: "profile" | "disclaimer";
		name: string;
		detail: string;
	} | null>(null);
	const [showAll, setShowAll] = useState(false);

	const switchVariant = useCallback((next: Variant) => {
		setVariant(next);
		const url = new URL(location.href);
		url.searchParams.set("variant", next);
		history.replaceState(null, "", url);
		setArea(next === "C" ? "catalog" : "policy");
		setEditorKind(null);
	}, []);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (
				!["ArrowLeft", "ArrowRight"].includes(event.key) ||
				(event.target instanceof HTMLElement &&
					(event.target.matches("input,textarea,select") ||
						event.target.isContentEditable))
			)
				return;
			const index = variants.findIndex((item) => item.key === variant);
			switchVariant(
				variants[
					(index + (event.key === "ArrowRight" ? 1 : 2)) % variants.length
				]?.key ?? "A",
			);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [variant, switchVariant]);

	function newProfile() {
		setEditorKind("profile");
		setEditorMode("new");
		setCopyName("");
		setCopyActions([]);
		setActionQuery("");
		setEditorProvider("GitHub");
		setNotice("");
	}

	function copyProfile() {
		setEditorKind("profile");
		setEditorMode("copy");
		setCopyName(`${profiles[profile].name} 副本`);
		setCopyActions([
			...readActions,
			...(profile === "write" ? writeActions : []),
		]);
		setActionQuery("");
		setEditorProvider("GitHub");
		setNotice("");
	}

	function newDisclaimer() {
		setEditorKind("disclaimer");
		setEditorMode("new");
		setCopyName("");
		setCopyText("");
		setDisclaimerScope("GLOBAL");
		setNotice("");
	}

	function copyDisclaimer() {
		setEditorKind("disclaimer");
		setEditorMode("copy");
		setCopyName(
			selectedDisclaimer === "global"
				? "全局基础条款新版本"
				: "GitHub 附加条款新版本",
		);
		setCopyText(selectedDisclaimer === "global" ? globalText : githubText);
		setDisclaimerScope(selectedDisclaimer === "global" ? "GLOBAL" : "PROVIDER");
		setNotice("");
	}

	function saveCopy() {
		if (editorKind)
			setDraftSummary({
				kind: editorKind,
				name: copyName,
				detail:
					editorKind === "profile"
						? `${editorProvider} · ${copyActions.length} 项示例能力`
						: `${disclaimerScope === "GLOBAL" ? "全局" : "Provider"} · zh-CN`,
			});
		setNotice(`${copyName}：草稿已保存在本地原型状态，未发布。`);
		setEditorKind(null);
	}

	const props = {
		area,
		setArea,
		kind,
		setKind,
		profile,
		setProfile,
		provider,
		setProvider,
		selectedDisclaimer,
		setSelectedDisclaimer,
		includeGithub,
		setIncludeGithub,
		inspectorOpen,
		setInspectorOpen,
		showAll,
		setShowAll,
		copyProfile,
		copyDisclaimer,
		newProfile,
		newDisclaimer,
		draftSummary,
	};
	const current = variants.find((item) => item.key === variant) ?? variants[0];
	return (
		<div className="app-shell proto-shell">
			<aside className="sidebar">
				<div className="brand-lockup sidebar-brand">
					<span className="brand-mark">C</span>
					<span>Connection</span>
				</div>
				<nav aria-label="Connection 导航">
					<div className="nav-link">
						<GitBranch size={18} />
						我的 Connection
					</div>
					<div className="nav-link">
						<ListChecks size={18} />
						待我审批
					</div>
					<div className="nav-link">
						<KeyRound size={18} />
						访问令牌
					</div>
					<div className="nav-separator" />
					<div className="nav-link active">
						<ListChecks size={18} />
						审批管理
					</div>
					<div className="nav-link">
						<BookOpen size={18} />
						操作记录
					</div>
					<div className="nav-link">
						<UsersRound size={18} />
						管理员
					</div>
				</nav>
				<div className="account-block">
					<strong>管理员</strong>
					<span>Connection</span>
				</div>
			</aside>
			<main className="main-content proto-main">
				<div className="shell-notification">
					<button type="button" aria-label="通知与待办">
						<Bell size={18} />
					</button>
				</div>
				<header className="page-header">
					<h1>连接审批管理</h1>
					<span className="proto-environment">GitHub / 生产目录示例</span>
				</header>
				{notice ? (
					<p className="proto-notice" role="status">
						{notice}
					</p>
				) : null}
				{variant === "A" ? (
					<VariantA {...props} />
				) : variant === "B" ? (
					<VariantB {...props} />
				) : (
					<VariantC {...props} />
				)}
			</main>
			{editorKind ? (
				<div className="proto-overlay" role="presentation">
					<section
						className="proto-dialog"
						role="dialog"
						aria-modal="true"
						aria-label={editorMode === "new" ? "新建目录版本" : "复制为新版本"}
					>
						<header>
							<div>
								<h2>
									{editorMode === "new"
										? editorKind === "profile"
											? "新建能力包"
											: "新建免责声明版本"
										: "复制为新版本"}
								</h2>
								<p>
									{editorMode === "copy"
										? "原版本保持不变"
										: "从空白内容开始配置"}
								</p>
							</div>
							<button
								type="button"
								className="proto-icon"
								aria-label="关闭"
								onClick={() => setEditorKind(null)}
							>
								<X size={18} />
							</button>
						</header>
						<label>
							名称
							<input
								value={copyName}
								onChange={(event) => setCopyName(event.target.value)}
							/>
						</label>
						{editorKind === "profile" ? (
							<div className="proto-copy-actions">
								<label>
									Provider
									<select
										value={editorProvider}
										disabled={editorMode === "copy"}
										onChange={(event) => {
											setEditorProvider(event.target.value);
											setCopyActions([]);
										}}
									>
										<option>GitHub</option>
										<option>Jira</option>
									</select>
								</label>
								<div className="proto-copy-toolbar">
									<strong>能力清单</strong>
									<span>
										{copyActions.length} /{" "}
										{editorProvider === "GitHub" ? exampleActions.length : 0}{" "}
										项示例能力已选
									</span>
								</div>
								{editorProvider === "GitHub" ? (
									<>
										<input
											type="search"
											aria-label="搜索能力"
											placeholder="搜索能力名称"
											value={actionQuery}
											onChange={(event) => setActionQuery(event.target.value)}
										/>
										<fieldset
											className="proto-copy-presets"
											aria-label="快捷选择"
										>
											<button
												type="button"
												onClick={() => setCopyActions(exampleActions)}
											>
												全选
											</button>
											<button
												type="button"
												onClick={() => setCopyActions(readActions)}
											>
												仅只读
											</button>
											<button
												type="button"
												onClick={() => setCopyActions(writeActions)}
											>
												仅只写
											</button>
											<button
												type="button"
												disabled={!copyActions.length}
												onClick={() => setCopyActions([])}
											>
												清空
											</button>
										</fieldset>
										<div className="proto-copy-list">
											{exampleActions
												.filter((action) =>
													action
														.toLowerCase()
														.includes(actionQuery.trim().toLowerCase()),
												)
												.map((action) => (
													<label key={action} className="proto-check">
														<input
															type="checkbox"
															checked={copyActions.includes(action)}
															onChange={() =>
																setCopyActions((current) =>
																	current.includes(action)
																		? current.filter((item) => item !== action)
																		: [...current, action],
																)
															}
														/>
														<span>{action}</span>
														<small
															className={
																writeActions.includes(action) ? "write" : ""
															}
														>
															{writeActions.includes(action) ? "WRITE" : "READ"}
														</small>
													</label>
												))}
										</div>
										<p>
											原型仅列出 27 项示例能力；正式目录为 GitHub v9 的 143 项。
										</p>
									</>
								) : (
									<p>Jira 目录未加入此示例。</p>
								)}
							</div>
						) : (
							<div className="proto-disclaimer-editor">
								<label>
									条款类型
									<select
										value={disclaimerScope}
										disabled={editorMode === "copy"}
										onChange={(event) => setDisclaimerScope(event.target.value)}
									>
										<option value="GLOBAL">全局基础条款</option>
										<option value="PROVIDER">Provider 附加条款</option>
									</select>
								</label>
								{disclaimerScope === "PROVIDER" ? (
									<label>
										Provider
										<select
											defaultValue="GitHub"
											disabled={editorMode === "copy"}
										>
											<option>GitHub</option>
											<option>Jira</option>
										</select>
									</label>
								) : null}
								<label>
									条款正文
									<textarea
										value={copyText}
										rows={8}
										onChange={(event) => setCopyText(event.target.value)}
									/>
								</label>
							</div>
						)}
						<footer>
							<button
								type="button"
								className="proto-secondary"
								onClick={() => setEditorKind(null)}
							>
								取消
							</button>
							<button
								type="button"
								className="proto-primary"
								onClick={saveCopy}
								disabled={
									!copyName.trim() ||
									(editorKind === "profile"
										? !copyActions.length
										: !copyText.trim())
								}
							>
								保存草稿
							</button>
						</footer>
					</section>
				</div>
			) : null}
			<fieldset className="proto-switcher" aria-label="原型方案切换">
				<button
					type="button"
					aria-label="上一个方案"
					onClick={() =>
						switchVariant(
							variants[
								(variants.findIndex((item) => item.key === variant) + 2) % 3
							]?.key ?? "A",
						)
					}
				>
					<ArrowLeft size={17} />
				</button>
				<strong>
					{current?.key} · {current?.name}
				</strong>
				<button
					type="button"
					aria-label="下一个方案"
					onClick={() =>
						switchVariant(
							variants[
								(variants.findIndex((item) => item.key === variant) + 1) % 3
							]?.key ?? "A",
						)
					}
				>
					<ArrowRight size={17} />
				</button>
				<span className="proto-state">
					{provider} /{" "}
					{provider === "GitHub" ? profiles[profile].name : "暂无能力包"} /{" "}
					{provider === "GitHub" && includeGithub
						? "全局+GitHub条款"
						: "仅全局条款"}
					{notice ? ` / ${notice}` : ""}
				</span>
			</fieldset>
		</div>
	);
}

type VariantProps = {
	area: "policy" | "catalog";
	setArea: (area: "policy" | "catalog") => void;
	kind: CatalogKind;
	setKind: (kind: CatalogKind) => void;
	profile: ProfileKey;
	setProfile: (profile: ProfileKey) => void;
	provider: string;
	setProvider: (provider: string) => void;
	selectedDisclaimer: string;
	setSelectedDisclaimer: (id: string) => void;
	includeGithub: boolean;
	setIncludeGithub: (value: boolean) => void;
	inspectorOpen: boolean;
	setInspectorOpen: (value: boolean) => void;
	showAll: boolean;
	setShowAll: (value: boolean) => void;
	copyProfile: () => void;
	copyDisclaimer: () => void;
	newProfile: () => void;
	newDisclaimer: () => void;
	draftSummary: {
		kind: "profile" | "disclaimer";
		name: string;
		detail: string;
	} | null;
};

function ProfileSummary({
	profile,
	onCopy,
	showAll,
	onToggle,
}: {
	profile: ProfileKey;
	onCopy: () => void;
	showAll: boolean;
	onToggle: () => void;
}) {
	const selected = profiles[profile];
	const actions = [
		...readActions,
		...(profile === "write" ? writeActions : []),
	];
	return (
		<section className="proto-detail">
			<div className="proto-detail-head">
				<div>
					<h3>{selected.name}</h3>
					<p>已发布 · GitHub v9</p>
				</div>
				<button type="button" className="proto-secondary" onClick={onCopy}>
					<Copy size={15} />
					复制为新能力包
				</button>
			</div>
			<div className="proto-metrics">
				<span>
					<strong>{selected.reads}</strong> READ
				</span>
				<span>
					<strong>{selected.writes}</strong> WRITE
				</span>
			</div>
			<div className="proto-list-head">
				<strong>能力清单</strong>
				<span>
					原型展示 {showAll ? actions.length : Math.min(8, actions.length)} 项 /
					实际 {selected.reads + selected.writes} 项
				</span>
			</div>
			<div className="proto-action-list">
				{actions.slice(0, showAll ? undefined : 8).map((action) => (
					<div key={action}>
						<span>{action}</span>
						<small className={writeActions.includes(action) ? "write" : ""}>
							{writeActions.includes(action) ? "WRITE" : "READ"}
						</small>
					</div>
				))}
			</div>
			<button type="button" className="proto-link" onClick={onToggle}>
				{showAll ? "收起示例" : "查看更多示例能力"}
				<ChevronDown size={15} />
			</button>
		</section>
	);
}

function DisclaimerSummary({
	selected,
	onCopy,
}: {
	selected: string;
	onCopy: () => void;
}) {
	return (
		<section className="proto-detail">
			<div className="proto-detail-head">
				<div>
					<h3>{selected === "global" ? "全局基础条款" : "GitHub 附加条款"}</h3>
					<p>已发布 · zh-CN</p>
				</div>
				<button type="button" className="proto-secondary" onClick={onCopy}>
					<Copy size={15} />
					创建新版本
				</button>
			</div>
			<div className="proto-legal">
				{selected === "global" ? globalText : githubText}
			</div>
		</section>
	);
}

function PolicyChoices(props: VariantProps) {
	return (
		<div className="proto-policy-choices">
			<label>
				Provider
				<select
					value={props.provider}
					onChange={(event) => props.setProvider(event.target.value)}
				>
					<option>GitHub</option>
					<option>Jira</option>
				</select>
			</label>
			<label>
				能力包
				<select
					value={props.provider === "GitHub" ? props.profile : "none"}
					disabled={props.provider !== "GitHub"}
					onChange={(event) =>
						props.setProfile(event.target.value as ProfileKey)
					}
				>
					{props.provider === "GitHub" ? (
						<>
							<option value="read">GitHub 只读</option>
							<option value="write">GitHub 协作写入</option>
						</>
					) : (
						<option value="none">暂无已发布能力包</option>
					)}
				</select>
			</label>
			<div className="proto-rule">
				<Check size={16} />
				<span>全局基础条款</span>
				<strong>必需</strong>
			</div>
			{props.provider === "GitHub" ? (
				<label className="proto-check">
					<input
						type="checkbox"
						checked={props.includeGithub}
						onChange={(event) => props.setIncludeGithub(event.target.checked)}
					/>
					GitHub 附加条款
				</label>
			) : null}
			<label>
				有效期
				<select defaultValue="90">
					<option value="90">90 天</option>
					<option value="365">365 天</option>
					<option value="permanent">永久</option>
				</select>
			</label>
		</div>
	);
}

function SelectedProfile(props: VariantProps) {
	return props.provider === "GitHub" ? (
		<ProfileSummary
			profile={props.profile}
			onCopy={props.copyProfile}
			showAll={props.showAll}
			onToggle={() => props.setShowAll(!props.showAll)}
		/>
	) : (
		<section className="proto-detail">
			<h3>Jira 暂无已发布能力包</h3>
			<p>在目录中创建并发布后才能配置策略。</p>
		</section>
	);
}

function CatalogList(props: VariantProps) {
	return (
		<div className="proto-catalog-list">
			<div className="proto-kind-tabs">
				<button
					type="button"
					className={props.kind === "profiles" ? "active" : ""}
					onClick={() => props.setKind("profiles")}
				>
					能力包
				</button>
				<button
					type="button"
					className={props.kind === "disclaimers" ? "active" : ""}
					onClick={() => props.setKind("disclaimers")}
				>
					免责声明
				</button>
			</div>
			{props.kind === "profiles" ? (
				<>
					<button
						type="button"
						className={props.profile === "read" ? "selected" : ""}
						onClick={() => props.setProfile("read")}
					>
						<strong>GitHub 只读</strong>
						<span>78 读 / 0 写</span>
					</button>
					<button
						type="button"
						className={props.profile === "write" ? "selected" : ""}
						onClick={() => props.setProfile("write")}
					>
						<strong>GitHub 协作写入</strong>
						<span>78 读 / 13 写</span>
					</button>
				</>
			) : (
				<>
					<button
						type="button"
						className={props.selectedDisclaimer === "global" ? "selected" : ""}
						onClick={() => props.setSelectedDisclaimer("global")}
					>
						<strong>全局基础条款</strong>
						<span>zh-CN</span>
					</button>
					<button
						type="button"
						className={props.selectedDisclaimer === "github" ? "selected" : ""}
						onClick={() => props.setSelectedDisclaimer("github")}
					>
						<strong>GitHub 附加条款</strong>
						<span>zh-CN</span>
					</button>
				</>
			)}
			{props.draftSummary?.kind ===
			(props.kind === "profiles" ? "profile" : "disclaimer") ? (
				<div className="proto-draft-row" role="status">
					<strong>
						{props.draftSummary.name} <small>草稿</small>
					</strong>
					<span>{props.draftSummary.detail}</span>
				</div>
			) : null}
		</div>
	);
}

function VariantA(props: VariantProps) {
	return (
		<div className="proto-a">
			<div className="proto-top-tabs">
				<button
					type="button"
					className={props.area === "policy" ? "active" : ""}
					onClick={() => props.setArea("policy")}
				>
					审批策略
				</button>
				<button
					type="button"
					className={props.area === "catalog" ? "active" : ""}
					onClick={() => props.setArea("catalog")}
				>
					目录管理
				</button>
			</div>
			{props.area === "policy" ? (
				<div className="proto-a-policy">
					<aside className="proto-a-policy-list">
						<div className="proto-list-title">
							策略版本{" "}
							<button type="button" aria-label="新增策略">
								<Plus size={16} />
							</button>
						</div>
						<p>暂无已发布策略</p>
						<button type="button" className="selected">
							新建审批策略 <ChevronRight size={16} />
						</button>
					</aside>
					<div className="proto-a-editor">
						<div className="proto-section-heading">
							<h2>新建审批策略</h2>
							<span>草稿</span>
						</div>
						<div className="proto-inline-tabs">
							<button type="button" className="active">
								能力与条款
							</button>
							<button type="button">审批链</button>
						</div>
						<PolicyChoices {...props} />
						<div className="proto-a-selected">
							<SelectedProfile {...props} />
							<DisclaimerSummary
								selected="global"
								onCopy={props.copyDisclaimer}
							/>
							{props.provider === "GitHub" && props.includeGithub ? (
								<DisclaimerSummary
									selected="github"
									onCopy={props.copyDisclaimer}
								/>
							) : null}
						</div>
					</div>
				</div>
			) : (
				<div className="proto-a-catalog">
					<div className="proto-section-heading">
						<h2>目录管理</h2>
						<button
							type="button"
							className="proto-primary"
							onClick={
								props.kind === "profiles"
									? props.newProfile
									: props.newDisclaimer
							}
						>
							<Plus size={16} />
							{props.kind === "profiles" ? "新建能力包" : "新建条款版本"}
						</button>
					</div>
					<div className="proto-master">
						<CatalogList {...props} />
						{props.kind === "profiles" ? (
							<ProfileSummary
								profile={props.profile}
								onCopy={props.copyProfile}
								showAll={props.showAll}
								onToggle={() => props.setShowAll(!props.showAll)}
							/>
						) : (
							<DisclaimerSummary
								selected={props.selectedDisclaimer}
								onCopy={props.copyDisclaimer}
							/>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function VariantB(props: VariantProps) {
	return (
		<div className="proto-b">
			<div className="proto-b-head">
				<div>
					<h2>新建审批策略</h2>
					<p>先选定审批范围，再配置审批人和有效期。</p>
				</div>
				<button
					type="button"
					className="proto-secondary"
					onClick={() => props.setArea("catalog")}
				>
					<BookOpen size={16} />
					管理能力目录
				</button>
			</div>
			<div className="proto-b-columns">
				<div className="proto-b-flow">
					<div className="proto-flow-step">
						<span className="proto-step-index">1</span>
						<div>
							<strong>申请范围</strong>
							<PolicyChoices {...props} />
							<button
								type="button"
								className="proto-link"
								onClick={() => props.setInspectorOpen(true)}
							>
								查看所选内容 <ArrowRight size={15} />
							</button>
						</div>
					</div>
					<div className="proto-flow-step">
						<span className="proto-step-index">2</span>
						<div>
							<strong>审批链</strong>
							<div className="proto-stage">
								<UsersRound size={17} />
								<span>第 1 级审批 · 任意一人</span>
								<button type="button" className="proto-secondary">
									设置审批人
								</button>
							</div>
						</div>
					</div>
					<div className="proto-flow-step">
						<span className="proto-step-index">3</span>
						<div>
							<strong>发布前核对</strong>
							<p>尚未配置审批人，不能发布策略。</p>
							<button type="button" className="proto-primary" disabled>
								发布策略
							</button>
						</div>
					</div>
				</div>
				{props.inspectorOpen ? (
					<aside className="proto-b-inspector">
						<div className="proto-section-heading">
							<h3>所选内容</h3>
							<button
								type="button"
								className="proto-icon"
								aria-label="关闭检查器"
								onClick={() => props.setInspectorOpen(false)}
							>
								<X size={17} />
							</button>
						</div>
						<SelectedProfile {...props} />
						<details open>
							<summary>全局基础条款</summary>
							<p>{globalText}</p>
						</details>
						{props.provider === "GitHub" && props.includeGithub ? (
							<details open>
								<summary>GitHub 附加条款</summary>
								<p>{githubText}</p>
							</details>
						) : null}
					</aside>
				) : null}
			</div>
			{props.area === "catalog" ? (
				<div className="proto-overlay" role="presentation">
					<section
						className="proto-catalog-drawer"
						role="dialog"
						aria-modal="true"
						aria-label="目录管理"
					>
						<header>
							<h2>目录管理</h2>
							<div className="proto-drawer-actions">
								<button
									type="button"
									className="proto-primary"
									onClick={
										props.kind === "profiles"
											? props.newProfile
											: props.newDisclaimer
									}
								>
									<Plus size={15} />
									{props.kind === "profiles" ? "新建能力包" : "新建条款版本"}
								</button>
								<button
									type="button"
									className="proto-icon"
									aria-label="关闭目录"
									onClick={() => props.setArea("policy")}
								>
									<X size={18} />
								</button>
							</div>
						</header>
						<div className="proto-master">
							<CatalogList {...props} />
							{props.kind === "profiles" ? (
								<ProfileSummary
									profile={props.profile}
									onCopy={props.copyProfile}
									showAll={props.showAll}
									onToggle={() => props.setShowAll(!props.showAll)}
								/>
							) : (
								<DisclaimerSummary
									selected={props.selectedDisclaimer}
									onCopy={props.copyDisclaimer}
								/>
							)}
						</div>
					</section>
				</div>
			) : null}
		</div>
	);
}

function VariantC(props: VariantProps) {
	return (
		<div className="proto-c">
			<div className="proto-c-head">
				<div className="proto-top-tabs">
					<button
						type="button"
						className={props.area === "catalog" ? "active" : ""}
						onClick={() => props.setArea("catalog")}
					>
						版本目录
					</button>
					<button
						type="button"
						className={props.area === "policy" ? "active" : ""}
						onClick={() => props.setArea("policy")}
					>
						策略配置
					</button>
				</div>
				<button
					type="button"
					className="proto-primary"
					onClick={
						props.kind === "profiles" ? props.newProfile : props.newDisclaimer
					}
				>
					<Plus size={16} />
					新建版本
				</button>
			</div>
			{props.area === "catalog" ? (
				<div className="proto-c-workbench">
					<aside className="proto-c-rail">
						<strong>目录</strong>
						<button
							type="button"
							className={props.kind === "profiles" ? "active" : ""}
							onClick={() => props.setKind("profiles")}
						>
							<GitBranch size={17} />
							能力包
						</button>
						<button
							type="button"
							className={props.kind === "disclaimers" ? "active" : ""}
							onClick={() => props.setKind("disclaimers")}
						>
							<FileText size={17} />
							免责声明
						</button>
						<div className="proto-rail-footer">
							<ShieldCheck size={16} />
							已发布版本不可修改
						</div>
					</aside>
					<section className="proto-c-table">
						<div className="proto-list-title">
							<strong>
								{props.kind === "profiles" ? "能力包" : "免责声明"}
							</strong>
							<button type="button" aria-label="搜索">
								<Search size={16} />
							</button>
						</div>
						<CatalogList {...props} />
					</section>
					<div className="proto-c-detail">
						{props.kind === "profiles" ? (
							<ProfileSummary
								profile={props.profile}
								onCopy={props.copyProfile}
								showAll={props.showAll}
								onToggle={() => props.setShowAll(!props.showAll)}
							/>
						) : (
							<DisclaimerSummary
								selected={props.selectedDisclaimer}
								onCopy={props.copyDisclaimer}
							/>
						)}
					</div>
				</div>
			) : (
				<div className="proto-c-policy">
					<div className="proto-section-heading">
						<h2>策略配置</h2>
						<span>尚未发布</span>
					</div>
					<div className="proto-c-policy-grid">
						<PolicyChoices {...props} />
						<div className="proto-c-policy-preview">
							<h3>本次审批范围</h3>
							{props.provider === "GitHub" ? (
								<div>
									<strong>{profiles[props.profile].name}</strong>
									<span>
										{profiles[props.profile].reads} 读 /{" "}
										{profiles[props.profile].writes} 写
									</span>
								</div>
							) : (
								<div>
									<strong>暂无已发布能力包</strong>
									<span>Jira</span>
								</div>
							)}
							<div>
								<strong>全局基础条款</strong>
								<span>必需</span>
							</div>
							{props.provider === "GitHub" && props.includeGithub ? (
								<div>
									<strong>GitHub 附加条款</strong>
									<span>zh-CN</span>
								</div>
							) : null}
							<button
								type="button"
								className="proto-link"
								onClick={() => props.setArea("catalog")}
							>
								查看目录中的完整版本 <ArrowRight size={15} />
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
