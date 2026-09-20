import type { AuthorizationPreviewResponse } from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	BookOpen,
	Check,
	GitBranch,
	KeyRound,
	Plus,
	ShieldOff,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { connectionApi } from "../api";
import { Button } from "../components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
import { useGithubOAuth } from "../github-oauth";
import { ConsoleShell, PageError } from "../shell";
import {
	ConnectionsView,
	EmptyState,
	PageHeader,
	providerLabel,
	Status,
} from "../views";

export function ConnectionsPage() {
	const queryClient = useQueryClient();
	const recoveryHandled = useRef(false);
	const [authorization, setAuthorization] = useState<{
		connectionId: string;
		consumerId: string;
		initialActionVersionIds: string[];
		preview: AuthorizationPreviewResponse | null;
		reviewed: boolean;
	} | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [bitbucketOpen, setBitbucketOpen] = useState(false);
	const [bitbucketPending, setBitbucketPending] = useState(false);
	const [bitbucketError, setBitbucketError] = useState<Error | null>(null);
	const [jiraOpen, setJiraOpen] = useState(false);
	const [jiraPending, setJiraPending] = useState(false);
	const [jiraError, setJiraError] = useState<Error | null>(null);
	const [confluenceOpen, setConfluenceOpen] = useState(false);
	const [confluencePending, setConfluencePending] = useState(false);
	const [confluenceError, setConfluenceError] = useState<Error | null>(null);
	const [jenkinsOpen, setJenkinsOpen] = useState(false);
	const [jenkinsPending, setJenkinsPending] = useState(false);
	const [jenkinsError, setJenkinsError] = useState<Error | null>(null);
	const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null);
	const callbackFailed =
		new URLSearchParams(window.location.search).get("oauth") ===
		"callback_failed";
	useEffect(() => {
		const search = new URLSearchParams(window.location.search);
		if (!["connect", "reauthorize"].includes(search.get("intent") ?? ""))
			return;
		const provider = search.get("provider");
		if (provider === "bitbucket") setBitbucketOpen(true);
		if (provider === "confluence") setConfluenceOpen(true);
		if (provider === "jira") setJiraOpen(true);
		if (provider === "jenkins-release") setJenkinsOpen(true);
	}, []);
	const overview = useQuery({
		queryKey: ["connections"],
		queryFn: connectionApi.getConnections,
	});
	const oauth = useGithubOAuth();
	const disconnect = useMutation({
		mutationFn: connectionApi.disconnectConnection,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["connections"] }),
	});
	const upgrade = useMutation({
		mutationFn: connectionApi.upgradeProviderConnection,
		onMutate: () => setUpgradeNotice(null),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
			setUpgradeNotice("连接已升级，可以重新确认客户端授权。");
		},
	});
	const connectBitbucket = async (accessToken: string) => {
		setBitbucketPending(true);
		setBitbucketError(null);
		try {
			await connectionApi.connectProviderCredential({
				accessToken,
				providerId: "bitbucket",
			});
			setBitbucketOpen(false);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setBitbucketError(
				error instanceof Error ? error : new Error("Bitbucket 连接失败"),
			);
		} finally {
			setBitbucketPending(false);
		}
	};
	const connectJira = async (credential: {
		password: string;
		username: string;
	}) => {
		setJiraPending(true);
		setJiraError(null);
		try {
			await connectionApi.connectProviderCredential({
				providerId: "jira",
				...credential,
			});
			setJiraOpen(false);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setJiraError(error instanceof Error ? error : new Error("Jira 连接失败"));
		} finally {
			setJiraPending(false);
		}
	};
	const connectConfluence = async (credential: {
		password: string;
		username: string;
	}) => {
		setConfluencePending(true);
		setConfluenceError(null);
		try {
			await connectionApi.connectProviderCredential({
				providerId: "confluence",
				...credential,
			});
			setConfluenceOpen(false);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setConfluenceError(
				error instanceof Error ? error : new Error("Confluence 连接失败"),
			);
		} finally {
			setConfluencePending(false);
		}
	};
	const connectJenkins = async (credential: {
		apiToken: string;
		username: string;
	}) => {
		setJenkinsPending(true);
		setJenkinsError(null);
		try {
			await connectionApi.connectProviderCredential({
				providerId: "jenkins-release",
				...credential,
			});
			setJenkinsOpen(false);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setJenkinsError(
				error instanceof Error ? error : new Error("Jenkins Release 连接失败"),
			);
		} finally {
			setJenkinsPending(false);
		}
	};
	const preview = useMutation({
		mutationFn: connectionApi.createAuthorizationPreview,
		onSuccess: (value, variables) =>
			setAuthorization((current) =>
				current
					? {
							...current,
							preview: value,
							reviewed: Boolean(variables.actionVersionIds),
						}
					: current,
			),
	});
	const confirm = useMutation({
		mutationFn: connectionApi.confirmAuthorization,
		onSuccess: async () => {
			setAuthorization(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		},
	});
	const revokeGrant = useMutation({
		mutationFn: connectionApi.revokeGrant,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["connections"] }),
	});

	const beginOAuth = () => oauth.begin();

	const data = overview.data?.overview;
	const githubConnectionHealthy = data?.connections.some(
		(connection) =>
			connection.providerId === "github" &&
			connection.status === "ACTIVE" &&
			!connection.requiresReconnect,
	);
	useEffect(() => {
		if (!callbackFailed || !githubConnectionHealthy) return;
		const url = new URL(window.location.href);
		url.searchParams.delete("oauth");
		window.history.replaceState(null, "", url);
	}, [callbackFailed, githubConnectionHealthy]);
	useEffect(() => {
		if (!data || recoveryHandled.current) return;
		const search = new URLSearchParams(window.location.search);
		if (search.get("intent") !== "authorize") return;
		const provider = search.get("provider");
		const candidates = data.connections.filter(
			(connection) =>
				connection.providerId === provider &&
				connection.status === "ACTIVE" &&
				!connection.requiresReconnect,
		);
		if (candidates.length !== 1 || !candidates[0]) return;
		recoveryHandled.current = true;
		setAuthorization({
			connectionId: candidates[0].id,
			consumerId: data.consumers[0]?.id ?? "",
			initialActionVersionIds: [],
			preview: null,
			reviewed: false,
		});
	}, [data]);
	const visibleGrants = data
		? showHistory
			? data.grants
			: data.grants.filter((grant) => grant.status === "ACTIVE")
		: [];
	return (
		<ConsoleShell>
			<PageHeader
				title="我的 Connection"
				action={
					<div className="row-actions">
						<Button
							variant="secondary"
							type="button"
							onClick={() => setJenkinsOpen(true)}
						>
							<SlidersHorizontal aria-hidden="true" size={17} />
							连接 Jenkins Release
						</Button>
						<Button
							variant="secondary"
							type="button"
							onClick={() => setConfluenceOpen(true)}
						>
							<BookOpen aria-hidden="true" size={17} />
							连接 Confluence
						</Button>
						<Button
							variant="secondary"
							type="button"
							onClick={() => setJiraOpen(true)}
						>
							<KeyRound aria-hidden="true" size={17} />
							连接 Jira
						</Button>
						<Button
							variant="secondary"
							type="button"
							onClick={() => setBitbucketOpen(true)}
						>
							<GitBranch aria-hidden="true" size={17} />
							连接 Bitbucket
						</Button>
						<Button type="button" onClick={beginOAuth}>
							<Plus aria-hidden="true" size={17} />
							连接 GitHub
						</Button>
					</div>
				}
			/>
			{overview.isPending ? (
				<div className="skeleton-block" role="status">
					正在加载 Connection...
				</div>
			) : null}
			{callbackFailed && overview.isSuccess && !githubConnectionHealthy ? (
				<p className="alert alert-warning" role="status">
					GitHub 授权回跳未确认，请以当前连接状态为准。
				</p>
			) : null}
			{overview.isError ? <PageError error={overview.error} /> : null}
			{oauth.isError ? <PageError error={oauth.error} /> : null}
			{bitbucketError ? <PageError error={bitbucketError} /> : null}
			{jiraError ? <PageError error={jiraError} /> : null}
			{confluenceError ? <PageError error={confluenceError} /> : null}
			{jenkinsError ? <PageError error={jenkinsError} /> : null}
			{disconnect.isError ? <PageError error={disconnect.error} /> : null}
			{revokeGrant.isError ? <PageError error={revokeGrant.error} /> : null}
			{upgrade.isError ? <PageError error={upgrade.error} /> : null}
			{upgradeNotice ? (
				<p className="alert alert-success" role="status">
					{upgradeNotice}
				</p>
			) : null}
			{data ? (
				<div className="content-stack">
					<section className="data-section">
						<ConnectionsView
							connections={data.connections}
							onAuthorize={(connectionId) =>
								setAuthorization({
									connectionId,
									consumerId: data.consumers[0]?.id ?? "",
									initialActionVersionIds: [],
									preview: null,
									reviewed: false,
								})
							}
							onDisconnect={(connectionId) => {
								const connection = data.connections.find(
									(entry) => entry.id === connectionId,
								);
								if (
									window.confirm(
										`确认断开这个 ${providerLabel(connection?.providerId ?? "")} Connection？`,
									)
								) {
									disconnect.mutate(connectionId);
								}
							}}
							onUpgrade={(connectionId) => upgrade.mutate(connectionId)}
							upgradingConnectionId={
								upgrade.isPending ? (upgrade.variables ?? null) : null
							}
							onReconnect={(connectionId) => {
								const connection = data.connections.find(
									(entry) => entry.id === connectionId,
								);
								if (connection?.providerId === "bitbucket") {
									setBitbucketOpen(true);
								} else if (connection?.providerId === "jira") {
									setJiraOpen(true);
								} else if (connection?.providerId === "confluence") {
									setConfluenceOpen(true);
								} else if (connection?.providerId === "jenkins-release") {
									setJenkinsOpen(true);
								} else {
									beginOAuth();
								}
							}}
						/>
					</section>

					<section className="data-section" aria-labelledby="grants-title">
						<div className="section-heading">
							<div>
								<h2 id="grants-title">客户端授权</h2>
								<p>每个客户端独立授权，可随时撤销。</p>
							</div>
							{data.grants.length ? (
								<label className="history-toggle">
									<input
										checked={showHistory}
										onChange={(event) => setShowHistory(event.target.checked)}
										type="checkbox"
									/>
									<span>显示历史授权</span>
								</label>
							) : null}
						</div>
						{visibleGrants.length ? (
							<div className="table-scroll">
								<table className="grant-table">
									<thead>
										<tr>
											<th>客户端</th>
											<th>平台</th>
											<th>账号</th>
											<th>状态</th>
											<th>授权能力</th>
											<th className="table-action">操作</th>
										</tr>
									</thead>
									<tbody>
										{visibleGrants.map((grant) => (
											<tr key={grant.id}>
												<td className="primary-cell">
													<div>{grant.consumerName}</div>
													<small className="table-secondary">
														{grant.consumerId}
													</small>
												</td>
												<td>
													<span className="provider-badge">
														{providerLabel(grant.providerId)}
													</span>
												</td>
												<td>
													<strong>{grant.connectionDisplayName}</strong>
													<small className="table-secondary">
														{grant.externalAccount}
													</small>
												</td>
												<td>
													<Status value={grant.status} />
												</td>
												<td>
													<GrantPermissions grant={grant} />
												</td>
												<td className="table-action">
													<div className="row-actions">
														<Button
															variant="secondary"
															size="icon"
															type="button"
															disabled={grant.status !== "ACTIVE"}
															onClick={() =>
																setAuthorization({
																	connectionId: grant.connectionId,
																	consumerId: grant.consumerId,
																	initialActionVersionIds:
																		grant.actionVersionIds,
																	preview: null,
																	reviewed: false,
																})
															}
															aria-label={`管理 ${grant.consumerName} 能力`}
															title="管理能力"
														>
															<SlidersHorizontal aria-hidden="true" size={17} />
														</Button>
														<Button
															variant="danger"
															size="icon"
															type="button"
															disabled={
																grant.status !== "ACTIVE" ||
																revokeGrant.isPending
															}
															onClick={() => revokeGrant.mutate(grant.id)}
															aria-label={`撤销 ${grant.consumerName}`}
															title={
																grant.status === "ACTIVE"
																	? "撤销授权"
																	: "历史授权不可操作"
															}
														>
															<ShieldOff aria-hidden="true" size={17} />
														</Button>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : data.grants.length ? (
							<EmptyState title="没有当前授权">
								当前只显示正常授权，打开“显示历史授权”可查看已撤销、已替换和已暂停记录。
							</EmptyState>
						) : (
							<EmptyState title="还没有客户端授权">
								从上方 Connection 选择客户端并确认授权。
							</EmptyState>
						)}
					</section>
				</div>
			) : null}

			<Dialog
				open={Boolean(authorization && data)}
				onOpenChange={(open) => {
					if (!open) setAuthorization(null);
				}}
			>
				{authorization && data ? (
					<DialogContent aria-describedby={undefined}>
						<DialogHeader>
							<DialogTitle>授权客户端</DialogTitle>
							<DialogClose asChild>
								<Button
									variant="secondary"
									size="icon"
									type="button"
									aria-label="关闭"
								>
									<X aria-hidden="true" size={18} />
								</Button>
							</DialogClose>
						</DialogHeader>
						{authorization.preview ? (
							<PreviewContent
								key={authorization.preview.preview.previewId}
								value={authorization.preview}
								busy={confirm.isPending || preview.isPending}
								initialActionVersionIds={authorization.initialActionVersionIds}
								reviewed={authorization.reviewed}
								onReview={(actionVersionIds) =>
									preview.mutate({
										actionVersionIds,
										connectionId: authorization.connectionId,
										consumerId: authorization.consumerId,
									})
								}
								onConfirm={() =>
									confirm.mutate({
										confirmationToken:
											authorization.preview?.preview.confirmationToken ?? "",
										idempotencyKey: authorization.preview?.idempotencyKey ?? "",
										previewId: authorization.preview?.preview.previewId ?? "",
									})
								}
							/>
						) : (
							<div className="form-stack">
								<label htmlFor="consumer">客户端</label>
								<select
									id="consumer"
									value={authorization.consumerId}
									onChange={(event) =>
										setAuthorization({
											...authorization,
											consumerId: event.target.value,
										})
									}
								>
									{data.consumers.map((consumer) => (
										<option key={consumer.id} value={consumer.id}>
											{consumer.name}
										</option>
									))}
								</select>
								<Button
									type="button"
									disabled={!authorization.consumerId || preview.isPending}
									onClick={() =>
										preview.mutate({
											connectionId: authorization.connectionId,
											consumerId: authorization.consumerId,
										})
									}
								>
									查看授权内容
								</Button>
							</div>
						)}
						{preview.isError ? <PageError error={preview.error} /> : null}
						{confirm.isError ? <PageError error={confirm.error} /> : null}
					</DialogContent>
				) : null}
			</Dialog>

			<Dialog
				open={jenkinsOpen}
				onOpenChange={(open) => {
					setJenkinsOpen(open);
					if (!open) setJenkinsError(null);
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接 Jenkins Release</DialogTitle>
						<DialogClose asChild>
							<Button
								variant="secondary"
								size="icon"
								type="button"
								aria-label="关闭"
							>
								<X aria-hidden="true" size={18} />
							</Button>
						</DialogClose>
					</DialogHeader>
					<form
						className="form-stack"
						onSubmit={(event: FormEvent<HTMLFormElement>) => {
							event.preventDefault();
							const form = new FormData(event.currentTarget);
							const username = form.get("username");
							const apiToken = form.get("apiToken");
							if (
								typeof username === "string" &&
								typeof apiToken === "string"
							) {
								event.currentTarget.reset();
								void connectJenkins({ apiToken, username });
							}
						}}
					>
						<label htmlFor="jenkins-release-username">Jenkins 用户名</label>
						<input
							autoComplete="username"
							defaultValue={overview.data?.account.email ?? ""}
							id="jenkins-release-username"
							maxLength={256}
							name="username"
							required
							type="text"
						/>
						<label htmlFor="jenkins-release-api-token">Jenkins API Token</label>
						<input
							autoComplete="off"
							id="jenkins-release-api-token"
							maxLength={8192}
							name="apiToken"
							required
							type="password"
						/>
						<div className="dialog-actions">
							<Button type="submit" disabled={jenkinsPending}>
								<SlidersHorizontal aria-hidden="true" size={17} />
								{jenkinsPending ? "正在验证" : "连接"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={bitbucketOpen}
				onOpenChange={(open) => {
					setBitbucketOpen(open);
					if (!open) setBitbucketError(null);
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接公司 Bitbucket</DialogTitle>
						<DialogClose asChild>
							<Button
								variant="secondary"
								size="icon"
								type="button"
								aria-label="关闭"
							>
								<X aria-hidden="true" size={18} />
							</Button>
						</DialogClose>
					</DialogHeader>
					<form
						className="form-stack"
						onSubmit={(event: FormEvent<HTMLFormElement>) => {
							event.preventDefault();
							const form = new FormData(event.currentTarget);
							const accessToken = form.get("accessToken");
							if (typeof accessToken === "string") {
								event.currentTarget.reset();
								void connectBitbucket(accessToken);
							}
						}}
					>
						<label htmlFor="bitbucket-access-token">
							Personal Access Token
						</label>
						<input
							autoComplete="off"
							id="bitbucket-access-token"
							maxLength={8192}
							name="accessToken"
							required
							type="password"
						/>
						<div className="dialog-actions">
							<Button type="submit" disabled={bitbucketPending}>
								<GitBranch aria-hidden="true" size={17} />
								{bitbucketPending ? "正在验证" : "连接"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={confluenceOpen}
				onOpenChange={(open) => {
					setConfluenceOpen(open);
					if (!open) setConfluenceError(null);
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接公司 Confluence</DialogTitle>
						<DialogClose asChild>
							<Button
								variant="secondary"
								size="icon"
								type="button"
								aria-label="关闭"
							>
								<X aria-hidden="true" size={18} />
							</Button>
						</DialogClose>
					</DialogHeader>
					<form
						className="form-stack"
						onSubmit={(event: FormEvent<HTMLFormElement>) => {
							event.preventDefault();
							const form = new FormData(event.currentTarget);
							const username = form.get("username");
							const password = form.get("password");
							if (
								typeof username === "string" &&
								typeof password === "string"
							) {
								event.currentTarget.reset();
								void connectConfluence({ password, username });
							}
						}}
					>
						<label htmlFor="confluence-username">Confluence 用户名</label>
						<input
							autoComplete="username"
							defaultValue={overview.data?.account.email ?? ""}
							id="confluence-username"
							maxLength={256}
							name="username"
							required
							type="text"
						/>
						<label htmlFor="confluence-password">Confluence 密码</label>
						<input
							autoComplete="current-password"
							id="confluence-password"
							maxLength={1024}
							name="password"
							required
							type="password"
						/>
						<p className="form-hint">
							用户名默认使用当前 Connection 账号；Confluence 密码会加密保存。
							Connection 服务端会自动管理公司 OAuth accessToken。
						</p>
						<div className="dialog-actions">
							<Button type="submit" disabled={confluencePending}>
								<BookOpen aria-hidden="true" size={17} />
								{confluencePending ? "正在验证" : "连接"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={jiraOpen}
				onOpenChange={(open) => {
					setJiraOpen(open);
					if (!open) setJiraError(null);
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接公司 Jira</DialogTitle>
						<DialogClose asChild>
							<Button
								variant="secondary"
								size="icon"
								type="button"
								aria-label="关闭"
							>
								<X aria-hidden="true" size={18} />
							</Button>
						</DialogClose>
					</DialogHeader>
					<form
						className="form-stack"
						onSubmit={(event: FormEvent<HTMLFormElement>) => {
							event.preventDefault();
							const form = new FormData(event.currentTarget);
							const username = form.get("username");
							const password = form.get("password");
							if (
								typeof username === "string" &&
								typeof password === "string"
							) {
								event.currentTarget.reset();
								void connectJira({ password, username });
							}
						}}
					>
						<label htmlFor="jira-username">Jira 用户名</label>
						<input
							autoComplete="username"
							id="jira-username"
							maxLength={256}
							name="username"
							required
							defaultValue={overview.data?.account.email ?? ""}
							type="text"
						/>
						<label htmlFor="jira-password">Jira 密码</label>
						<input
							autoComplete="current-password"
							id="jira-password"
							maxLength={1024}
							name="password"
							required
							type="password"
						/>
						<p className="form-hint">
							用户名默认使用当前 Connection 账号；Jira 密码会加密保存。
							Connection 服务端会自动管理公司 OAuth accessToken。
						</p>
						<div className="dialog-actions">
							<Button type="submit" disabled={jiraPending}>
								<KeyRound aria-hidden="true" size={17} />
								{jiraPending ? "正在验证" : "连接"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</ConsoleShell>
	);
}

export function PreviewContent(props: {
	busy: boolean;
	initialActionVersionIds?: string[];
	onConfirm: () => void;
	onReview?: (actionVersionIds: string[]) => void;
	reviewed?: boolean;
	value: AuthorizationPreviewResponse;
}) {
	const availableActionIds = new Set(
		props.value.preview.actions.map((action) => action.id),
	);
	const defaultSelection = props.initialActionVersionIds?.length
		? props.initialActionVersionIds.filter((id) => availableActionIds.has(id))
		: props.value.preview.actions
				.filter((action) => action.effect === "READ")
				.map((action) => action.id);
	const [selected, setSelected] = useState(() => new Set(defaultSelection));
	const [query, setQuery] = useState("");
	const [effect, setEffect] = useState<"ALL" | "READ" | "WRITE">("ALL");
	const visibleActions = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return props.value.preview.actions.filter(
			(action) =>
				(effect === "ALL" || action.effect === effect) &&
				(!normalized ||
					action.name.toLowerCase().includes(normalized) ||
					action.description.toLowerCase().includes(normalized)),
		);
	}, [effect, props.value.preview.actions, query]);
	if (props.reviewed === false && props.onReview) {
		return (
			<div className="compact content-stack">
				<div className="account-switch">
					<strong>
						{props.value.preview.targetConnection.externalAccount}
					</strong>
					<span>{props.value.preview.consumer.name}</span>
				</div>
				<div className="permission-controls">
					<input
						aria-label="搜索能力"
						placeholder="搜索 Action"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<select
						aria-label="能力类型"
						value={effect}
						onChange={(event) =>
							setEffect(event.target.value as "ALL" | "READ" | "WRITE")
						}
					>
						<option value="ALL">全部</option>
						<option value="READ">读取</option>
						<option value="WRITE">写入</option>
					</select>
				</div>
				<div className="row-actions">
					<button
						className="button button-secondary"
						type="button"
						onClick={() =>
							setSelected(
								(current) =>
									new Set([
										...current,
										...visibleActions.map((action) => action.id),
									]),
							)
						}
					>
						选择当前结果
					</button>
					<button
						className="button button-secondary"
						type="button"
						onClick={() => setSelected(new Set())}
					>
						清空
					</button>
				</div>
				<p className="scope-summary">
					已选择 {selected.size} / 共 {props.value.preview.actions.length} 项
				</p>
				<ul className="permission-list">
					{visibleActions.map((action) => (
						<li key={action.id}>
							<label className="permission-option">
								<input
									checked={selected.has(action.id)}
									type="checkbox"
									onChange={(event) =>
										setSelected((current) => {
											const next = new Set(current);
											if (event.target.checked) next.add(action.id);
											else next.delete(action.id);
											return next;
										})
									}
								/>
								<span>
									<strong>{action.name}</strong>
									<small>{action.effect === "WRITE" ? "写入" : "读取"}</small>
								</span>
							</label>
						</li>
					))}
				</ul>
				<div className="dialog-actions">
					<Button
						type="button"
						disabled={props.busy || selected.size === 0}
						onClick={() => props.onReview?.([...selected].sort())}
					>
						查看授权差异
					</Button>
				</div>
			</div>
		);
	}
	return (
		<div className="compact content-stack">
			<div className="account-switch authorization-summary">
				<div>
					<strong>
						{props.value.preview.targetConnection.externalAccount}
					</strong>
					<span>{props.value.preview.consumer.name}</span>
				</div>
				<Button type="button" disabled={props.busy} onClick={props.onConfirm}>
					<Check aria-hidden="true" size={17} />
					{props.busy ? "正在确认" : "确认授权"}
				</Button>
			</div>
			<ul className="permission-list">
				{props.value.preview.actions.map((action) => (
					<li key={action.id}>
						<div>
							<strong>{action.name}</strong>
							<p>{action.description}</p>
							<p className="scope-summary">
								所需 scope：
								{action.requiredScopes.length
									? action.requiredScopes.join("、")
									: "无"}
							</p>
						</div>
						<span className="effect-badge">
							{action.effect === "WRITE" ? "写入" : "读取"}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function GrantPermissions(props: {
	grant: {
		actions: Array<{ effect: "READ" | "WRITE"; id: string; name: string }>;
		actionVersionIds: string[];
	};
}) {
	const actions = props.grant.actions ?? [];
	const read = actions.filter((action) => action.effect === "READ");
	const write = actions.filter((action) => action.effect === "WRITE");
	const total = actions.length || props.grant.actionVersionIds?.length || 0;
	return (
		<div className="permission-summary">
			<strong>{total} 项</strong>
			<span>{read.length} 读</span>
			<span>{write.length} 写</span>
		</div>
	);
}
