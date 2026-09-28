import type {
	ApprovalPolicyCatalog,
	CapabilityProfileDetailResponse,
} from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { connectionApi } from "../api";
import { Button } from "../components/ui/button";
import { PageError } from "../shell";

type Catalog = ApprovalPolicyCatalog;
type Profile = Catalog["profiles"][number];
type Disclaimer = Catalog["disclaimers"][number];

export function ApprovalCatalogManager(props: {
	catalog: Catalog | undefined;
	initialProfileId?: string;
	onRefresh: () => Promise<unknown>;
}) {
	const client = useQueryClient();
	const [kind, setKind] = useState<"profiles" | "disclaimers">("profiles");
	const [profileId, setProfileId] = useState(props.initialProfileId ?? "");
	const [disclaimerId, setDisclaimerId] = useState("");
	const [editor, setEditor] = useState<"profile" | "disclaimer" | null>(null);
	const [editingProfile, setEditingProfile] = useState<{
		id: string;
		revision: string;
	} | null>(null);
	const [editingDisclaimer, setEditingDisclaimer] = useState<{
		id: string;
		revision: string;
	} | null>(null);
	const [providerLocked, setProviderLocked] = useState(false);
	const [disclaimerScopeLocked, setDisclaimerScopeLocked] = useState(false);
	const [profileName, setProfileName] = useState("");
	const [providerReleaseId, setProviderReleaseId] = useState("");
	const [actionIds, setActionIds] = useState<string[]>([]);
	const [actionQuery, setActionQuery] = useState("");
	const [disclaimerKind, setDisclaimerKind] = useState<"GLOBAL" | "PROVIDER">(
		"GLOBAL",
	);
	const [disclaimerProvider, setDisclaimerProvider] = useState("");
	const [disclaimerLocale, setDisclaimerLocale] = useState("zh-CN");
	const [disclaimerContent, setDisclaimerContent] = useState("");
	const [materialChange, setMaterialChange] = useState(false);
	const [notice, setNotice] = useState("");
	const profile = props.catalog?.profiles.find((item) => item.id === profileId);
	const disclaimer = props.catalog?.disclaimers.find(
		(item) => item.id === disclaimerId,
	);
	const detail = useQuery({
		queryKey: ["approval-profile-detail", profileId],
		queryFn: () => connectionApi.getApprovalCapabilityProfile(profileId),
		enabled: Boolean(profileId),
	});
	const provider = props.catalog?.providers.find(
		(item) => item.providerReleaseId === providerReleaseId,
	);
	const providerActions = provider?.actions ?? [];
	const normalizedQuery = actionQuery.trim().toLowerCase();
	const visibleActions = providerActions.filter(
		(action) =>
			action.name.toLowerCase().includes(normalizedQuery) ||
			action.effect.toLowerCase().includes(normalizedQuery),
	);
	const nameConflict =
		props.catalog?.profiles.some(
			(item) =>
				item.id !== editingProfile?.id &&
				item.status === "PUBLISHED" &&
				item.providerReleaseId === providerReleaseId &&
				item.name === profileName.trim(),
		) ?? false;
	const publishConflict =
		props.catalog?.profiles.some(
			(item) =>
				item.id !== profile?.id &&
				item.status === "PUBLISHED" &&
				item.providerReleaseId === profile?.providerReleaseId &&
				item.name === profile?.name,
		) ?? false;

	useEffect(() => {
		if (!profileId && props.catalog?.profiles[0])
			setProfileId(props.catalog.profiles[0].id);
		if (!disclaimerId && props.catalog?.disclaimers[0])
			setDisclaimerId(props.catalog.disclaimers[0].id);
	}, [props.catalog, profileId, disclaimerId]);

	const saveProfile = useMutation({
		mutationFn: (body: {
			name: string;
			providerReleaseId: string;
			actionVersionIds: string[];
		}) =>
			editingProfile
				? connectionApi.updateApprovalCapabilityProfileDraft({
						profileId: editingProfile.id,
						revision: editingProfile.revision,
						body,
					})
				: connectionApi.createApprovalCapabilityProfile(body),
		onSuccess: async (created) => {
			setEditor(null);
			setProfileId(created.capabilityProfileId);
			setNotice("能力包草稿已保存；发布前可核对完整清单。");
			await props.onRefresh();
			await client.invalidateQueries({ queryKey: ["approval-profile-detail"] });
		},
	});
	const publishProfile = useMutation({
		mutationFn: connectionApi.publishApprovalCapabilityProfile,
		onSuccess: async () => {
			setNotice("能力包已发布；策略仍需单独配置和发布。");
			await props.onRefresh();
			await client.invalidateQueries({ queryKey: ["approval-profile-detail"] });
		},
	});
	const saveDisclaimer = useMutation({
		mutationFn: (body: {
			kind: "GLOBAL" | "PROVIDER";
			locale: string;
			content: string;
			materialChange: boolean;
			providerId?: string;
		}) =>
			editingDisclaimer
				? connectionApi.updateApprovalDisclaimerDraft({
						disclaimerId: editingDisclaimer.id,
						revision: editingDisclaimer.revision,
						body,
					})
				: connectionApi.createApprovalDisclaimer(body),
		onSuccess: async (created) => {
			setEditor(null);
			setDisclaimerId(created.disclaimerVersionId);
			setNotice("免责声明草稿已保存；发布前可核对正文。");
			await props.onRefresh();
		},
	});
	const publishDisclaimer = useMutation({
		mutationFn: connectionApi.publishApprovalDisclaimer,
		onSuccess: async () => {
			setNotice("免责声明版本已发布；策略仍需单独选择新版。");
			await props.onRefresh();
		},
	});
	const error =
		saveProfile.error ||
		publishProfile.error ||
		saveDisclaimer.error ||
		publishDisclaimer.error;
	const busy =
		saveProfile.isPending ||
		publishProfile.isPending ||
		saveDisclaimer.isPending ||
		publishDisclaimer.isPending;

	function newProfile() {
		setKind("profiles");
		setEditor("profile");
		setEditingProfile(null);
		setProviderLocked(false);
		setProfileName("");
		setProviderReleaseId(props.catalog?.providers[0]?.providerReleaseId ?? "");
		setActionIds([]);
		setActionQuery("");
		setNotice("");
	}

	function copyProfile(
		source: Profile,
		sourceDetail: CapabilityProfileDetailResponse,
	) {
		setKind("profiles");
		setEditor("profile");
		setEditingProfile(null);
		setProviderLocked(true);
		setProfileName(`${source.name} 新版`);
		setProviderReleaseId(source.providerReleaseId);
		setActionIds(sourceDetail.profile.actions.map((action) => action.id));
		setActionQuery("");
		setNotice("");
	}

	function editProfileDraft(
		source: Profile,
		sourceDetail: CapabilityProfileDetailResponse,
	) {
		setKind("profiles");
		setEditor("profile");
		setEditingProfile({
			id: source.id,
			revision: sourceDetail.profile.revision,
		});
		setProviderLocked(true);
		setProfileName(source.name);
		setProviderReleaseId(source.providerReleaseId);
		setActionIds(sourceDetail.profile.actions.map((action) => action.id));
		setActionQuery("");
		setNotice("");
	}

	function newDisclaimer() {
		setKind("disclaimers");
		setEditor("disclaimer");
		setEditingDisclaimer(null);
		setDisclaimerScopeLocked(false);
		setDisclaimerKind("GLOBAL");
		setDisclaimerProvider("");
		setDisclaimerLocale("zh-CN");
		setDisclaimerContent("");
		setMaterialChange(false);
		setNotice("");
	}

	function copyDisclaimer(source: Disclaimer) {
		setKind("disclaimers");
		setEditor("disclaimer");
		setEditingDisclaimer(null);
		setDisclaimerScopeLocked(true);
		setDisclaimerKind(source.kind === "GLOBAL" ? "GLOBAL" : "PROVIDER");
		setDisclaimerProvider(source.providerId ?? "");
		setDisclaimerLocale(source.locale);
		setDisclaimerContent(source.content);
		setMaterialChange(source.materialChange);
		setNotice("");
	}

	function editDisclaimerDraft(source: Disclaimer) {
		copyDisclaimer(source);
		setEditingDisclaimer({ id: source.id, revision: source.revision });
	}

	return (
		<section className="approval-directory" aria-label="目录管理">
			{notice ? (
				<p role="status" className="approval-notice">
					{notice}
				</p>
			) : null}
			{error ? <PageError error={error} /> : null}
			<div className="approval-directory-head">
				<h2>目录管理</h2>
				<Button onClick={kind === "profiles" ? newProfile : newDisclaimer}>
					<Plus size={16} />
					{kind === "profiles" ? "新建能力包" : "新建免责声明"}
				</Button>
			</div>
			<div className="approval-directory-layout">
				<aside className="approval-directory-list">
					<div className="approval-directory-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={kind === "profiles"}
							className={kind === "profiles" ? "active" : ""}
							onClick={() => {
								setKind("profiles");
								setEditor(null);
							}}
						>
							能力包
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={kind === "disclaimers"}
							className={kind === "disclaimers" ? "active" : ""}
							onClick={() => {
								setKind("disclaimers");
								setEditor(null);
							}}
						>
							免责声明
						</button>
					</div>
					{kind === "profiles"
						? props.catalog?.profiles.map((item) => (
								<button
									key={item.id}
									type="button"
									className={profileId === item.id && !editor ? "active" : ""}
									onClick={() => {
										setProfileId(item.id);
										setEditor(null);
									}}
								>
									<strong>{item.name}</strong>
									<span>
										{item.status} ·{" "}
										{props.catalog?.providers.find(
											(provider) =>
												provider.providerReleaseId === item.providerReleaseId,
										)?.provider ?? item.providerReleaseId}
									</span>
								</button>
							))
						: props.catalog?.disclaimers.map((item) => (
								<button
									key={item.id}
									type="button"
									className={
										disclaimerId === item.id && !editor ? "active" : ""
									}
									onClick={() => {
										setDisclaimerId(item.id);
										setEditor(null);
									}}
								>
									<strong>
										{item.kind === "GLOBAL"
											? "全局基础条款"
											: `${item.providerId} 附加条款`}
									</strong>
									<span>
										{item.status} · {item.locale} · {item.id.slice(-8)}
									</span>
								</button>
							))}
					{!props.catalog?.profiles.length && kind === "profiles" ? (
						<p>暂无能力包。</p>
					) : null}
					{!props.catalog?.disclaimers.length && kind === "disclaimers" ? (
						<p>暂无免责声明。</p>
					) : null}
				</aside>
				<div className="approval-directory-detail">
					{editor === "profile" ? (
						<div className="approval-directory-form">
							<h3>
								{editingProfile
									? "修改能力包草稿"
									: providerLocked
										? "复制为新能力包"
										: "新建能力包"}
							</h3>
							<label>
								名称
								<input
									value={profileName}
									maxLength={120}
									onChange={(event) => setProfileName(event.target.value)}
								/>
							</label>
							{nameConflict ? (
								<p role="alert">同名发布会替换现有能力包，请使用新名称。</p>
							) : null}
							<label>
								Provider
								<select
									value={providerReleaseId}
									disabled={providerLocked}
									onChange={(event) => {
										setProviderReleaseId(event.target.value);
										setActionIds([]);
									}}
								>
									<option value="">选择连接器</option>
									{props.catalog?.providers.map((item) => (
										<option
											key={item.providerReleaseId}
											value={item.providerReleaseId}
										>
											{item.provider} · {item.providerReleaseId}
										</option>
									))}
								</select>
							</label>
							<div className="approval-action-toolbar">
								<input
									type="search"
									aria-label="搜索能力"
									placeholder="搜索能力"
									value={actionQuery}
									disabled={!provider}
									onChange={(event) => setActionQuery(event.target.value)}
								/>
								<span role="status">
									已选 {actionIds.length} / {providerActions.length}
								</span>
								<fieldset
									className="approval-action-presets"
									aria-label="快捷选择"
								>
									<button
										type="button"
										disabled={!providerActions.length}
										onClick={() =>
											setActionIds(providerActions.map((action) => action.id))
										}
									>
										全选
									</button>
									<button
										type="button"
										disabled={
											!providerActions.some(
												(action) => action.effect === "READ",
											)
										}
										onClick={() =>
											setActionIds(
												providerActions
													.filter((action) => action.effect === "READ")
													.map((action) => action.id),
											)
										}
									>
										仅只读
									</button>
									<button
										type="button"
										disabled={
											!providerActions.some(
												(action) => action.effect === "WRITE",
											)
										}
										onClick={() =>
											setActionIds(
												providerActions
													.filter((action) => action.effect === "WRITE")
													.map((action) => action.id),
											)
										}
									>
										仅只写
									</button>
									<button
										type="button"
										disabled={!actionIds.length}
										onClick={() => setActionIds([])}
									>
										清空
									</button>
								</fieldset>
							</div>
							<div className="approval-action-list">
								{visibleActions.map((action) => (
									<label key={action.id}>
										<input
											type="checkbox"
											checked={actionIds.includes(action.id)}
											onChange={() =>
												setActionIds((current) =>
													current.includes(action.id)
														? current.filter((id) => id !== action.id)
														: [...current, action.id],
												)
											}
										/>
										<span>{action.name}</span>
										<small
											className={
												action.effect === "WRITE" ? "approval-action-write" : ""
											}
										>
											{action.effect}
										</small>
									</label>
								))}
							</div>
							<div className="approval-directory-actions">
								<Button variant="secondary" onClick={() => setEditor(null)}>
									取消
								</Button>
								<Button
									disabled={
										busy ||
										!profileName.trim() ||
										!actionIds.length ||
										nameConflict
									}
									onClick={() =>
										saveProfile.mutate({
											name: profileName,
											providerReleaseId,
											actionVersionIds: actionIds,
										})
									}
								>
									保存草稿
								</Button>
							</div>
						</div>
					) : editor === "disclaimer" ? (
						<div className="approval-directory-form">
							<h3>
								{editingDisclaimer ? "修改免责声明草稿" : "新建免责声明版本"}
							</h3>
							<label>
								条款类型
								<select
									value={disclaimerKind}
									disabled={disclaimerScopeLocked}
									onChange={(event) =>
										setDisclaimerKind(
											event.target.value as "GLOBAL" | "PROVIDER",
										)
									}
								>
									<option value="GLOBAL">全局基础条款</option>
									<option value="PROVIDER">Provider 附加条款</option>
								</select>
							</label>
							{disclaimerKind === "PROVIDER" ? (
								<label>
									Provider
									<select
										value={disclaimerProvider}
										disabled={disclaimerScopeLocked}
										onChange={(event) =>
											setDisclaimerProvider(event.target.value)
										}
									>
										<option value="">选择连接器</option>
										{[
											...new Set(
												props.catalog?.providers.map((item) => item.provider) ??
													[],
											),
										].map((item) => (
											<option key={item} value={item}>
												{item}
											</option>
										))}
									</select>
								</label>
							) : null}
							<label>
								语言
								<input
									value={disclaimerLocale}
									onChange={(event) => setDisclaimerLocale(event.target.value)}
								/>
							</label>
							<label>
								条款正文
								<textarea
									rows={8}
									value={disclaimerContent}
									onChange={(event) => setDisclaimerContent(event.target.value)}
								/>
							</label>
							<label className="approval-toggle">
								<input
									type="checkbox"
									checked={materialChange}
									onChange={(event) => setMaterialChange(event.target.checked)}
								/>
								重大内容变化
							</label>
							<div className="approval-directory-actions">
								<Button variant="secondary" onClick={() => setEditor(null)}>
									取消
								</Button>
								<Button
									disabled={
										busy ||
										!disclaimerContent.trim() ||
										(disclaimerKind === "PROVIDER" && !disclaimerProvider)
									}
									onClick={() =>
										saveDisclaimer.mutate({
											kind: disclaimerKind,
											locale: disclaimerLocale,
											content: disclaimerContent,
											materialChange,
											...(disclaimerKind === "PROVIDER"
												? { providerId: disclaimerProvider }
												: {}),
										})
									}
								>
									保存草稿
								</Button>
							</div>
						</div>
					) : kind === "profiles" && profile ? (
						<div className="approval-directory-version">
							<div className="approval-directory-version-head">
								<div>
									<h3>{profile.name}</h3>
									<p>
										{profile.status} · {profile.providerReleaseId}
									</p>
								</div>
								<Button
									variant="secondary"
									disabled={!detail.data}
									onClick={() =>
										detail.data && copyProfile(profile, detail.data)
									}
								>
									<Copy size={15} />
									复制为新能力包
								</Button>
							</div>
							{detail.isError ? (
								<PageError error={detail.error} />
							) : detail.isPending ? (
								<p role="status">正在加载能力清单…</p>
							) : (
								<>
									<div className="approval-directory-count">
										<strong>
											{
												detail.data?.profile.actions.filter(
													(action) => action.effect === "READ",
												).length
											}{" "}
											读
										</strong>
										<strong>
											{
												detail.data?.profile.actions.filter(
													(action) => action.effect === "WRITE",
												).length
											}{" "}
											写
										</strong>
									</div>
									<div className="approval-action-list">
										{detail.data?.profile.actions.map((action) => (
											<div key={action.id} className="approval-action-detail">
												<span>
													<strong>{action.name}</strong>
													<small>{action.description}</small>
												</span>
												<small
													className={
														action.effect === "WRITE"
															? "approval-action-write"
															: ""
													}
												>
													{action.effect}
													{action.status === "PUBLISHED"
														? ""
														: ` · ${action.status}`}
												</small>
											</div>
										))}
									</div>
								</>
							)}
							{profile.status === "DRAFT" ? (
								<div className="approval-directory-actions">
									{publishConflict ? (
										<p role="alert">
											同名发布会替换现有能力包，请先修改草稿名称。
										</p>
									) : null}
									{detail.data?.profile.actions.some(
										(action) => action.status !== "PUBLISHED",
									) ? (
										<p role="alert">包含已停用 Action，请先修改草稿。</p>
									) : null}
									<Button
										variant="secondary"
										disabled={!detail.data}
										onClick={() =>
											detail.data && editProfileDraft(profile, detail.data)
										}
									>
										修改草稿
									</Button>
									<Button
										disabled={
											busy ||
											detail.isPending ||
											detail.isError ||
											publishConflict ||
											Boolean(
												detail.data?.profile.actions.some(
													(action) => action.status !== "PUBLISHED",
												),
											)
										}
										onClick={() => publishProfile.mutate(profile.id)}
									>
										发布能力包
									</Button>
								</div>
							) : null}
						</div>
					) : kind === "disclaimers" && disclaimer ? (
						<div className="approval-directory-version">
							<div className="approval-directory-version-head">
								<div>
									<h3>
										{disclaimer.kind === "GLOBAL"
											? "全局基础条款"
											: `${disclaimer.providerId} 附加条款`}
									</h3>
									<p>
										{disclaimer.status} · {disclaimer.locale} · {disclaimer.id}
									</p>
								</div>
								<Button
									variant="secondary"
									disabled={disclaimer.kind === "POLICY"}
									title={
										disclaimer.kind === "POLICY"
											? "策略专属条款暂不支持复制"
											: undefined
									}
									onClick={() => copyDisclaimer(disclaimer)}
								>
									<Copy size={15} />
									创建新版本
								</Button>
							</div>
							<div className="approval-disclaimer-content">
								{disclaimer.content}
							</div>
							{disclaimer.status === "DRAFT" ? (
								<div className="approval-directory-actions">
									<Button
										variant="secondary"
										onClick={() => editDisclaimerDraft(disclaimer)}
									>
										修改草稿
									</Button>
									<Button
										disabled={busy}
										onClick={() => publishDisclaimer.mutate(disclaimer.id)}
									>
										发布免责声明
									</Button>
								</div>
							) : null}
						</div>
					) : (
						<p>选择一个版本查看内容。</p>
					)}
				</div>
			</div>
		</section>
	);
}
