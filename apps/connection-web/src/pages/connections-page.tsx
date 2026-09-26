import type {
	AccessRequestsResponse,
	AuthorizationPreviewResponse,
	Connection,
	Grant,
	ProviderCredentialRequest,
} from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	BookOpen,
	Check,
	ChevronRight,
	GitBranch,
	KeyRound,
	Plus,
	Search,
	ShieldOff,
	SlidersHorizontal,
	X,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

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
	type ConnectorProviderId,
	connectorDefinitions,
	EmptyState,
	PageHeader,
	providerLabel,
	Status,
} from "../views";
import { AccessRequestPanel } from "./access-request-panel";

const accessStateLabels: Record<string, string> = {
	DISCONNECTED: "已断开",
	EXPIRED: "已到期",
	REAPPROVAL_REQUIRED: "待重审",
	REVOKED: "已撤销",
	SUSPENDED: "已暂停",
};

export function ConnectionsPage() {
	const queryClient = useQueryClient();
	const recoveryHandled = useRef(false);
	const [authorization, setAuthorization] = useState<{
		connectionId: string;
		consumerId: string;
		initialActions: Grant["actions"] | null;
		preview: AuthorizationPreviewResponse | null;
		reviewed: boolean;
	} | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [bitbucketOpen, setBitbucketOpen] = useState(false);
	const [bitbucketPending, setBitbucketPending] = useState(false);
	const [bitbucketError, setBitbucketError] = useState<Error | null>(null);
	const [rehoboamOpen, setRehoboamOpen] = useState(false);
	const [rehoboamPending, setRehoboamPending] = useState(false);
	const [rehoboamError, setRehoboamError] = useState<Error | null>(null);
	const [manhattanOpen, setManhattanOpen] = useState(false);
	const [manhattanPending, setManhattanPending] = useState(false);
	const [manhattanError, setManhattanError] = useState<Error | null>(null);
	const [jiraOpen, setJiraOpen] = useState(false);
	const [jiraPending, setJiraPending] = useState(false);
	const [jiraError, setJiraError] = useState<Error | null>(null);
	const [confluenceOpen, setConfluenceOpen] = useState(false);
	const [confluencePending, setConfluencePending] = useState(false);
	const [confluenceError, setConfluenceError] = useState<Error | null>(null);
	const [datalegoError, setDatalegoError] = useState<Error | null>(null);
	const [jenkinsOpen, setJenkinsOpen] = useState(false);
	const [jenkinsProviderId, setJenkinsProviderId] = useState<
		"jenkins-ci" | "jenkins-release"
	>("jenkins-release");
	const [jenkinsPending, setJenkinsPending] = useState(false);
	const [jenkinsError, setJenkinsError] = useState<Error | null>(null);
	const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null);
	const [requestTrigger, setRequestTrigger] = useState(0);
	const [requestTargetProvider, setRequestTargetProvider] = useState("");
	const [renewalTarget, setRenewalTarget] =
		useState<Connection["accessAuthorization"]>(null);
	const [renewalProviderId, setRenewalProviderId] = useState("");
	const [reconnectTargetId, setReconnectTargetId] = useState<string | null>(
		null,
	);
	const [approvalRequiredProvider, setApprovalRequiredProvider] =
		useState<ConnectorProviderId | null>(null);
	const connectSearch = new URLSearchParams(window.location.search);
	const accessRequestId = connectSearch.get("accessRequestId") ?? undefined;
	const approvedProvider = connectSearch.get("provider");
	const prepareAttempted = useRef<string | undefined>(undefined);
	const approvedRequest = useQuery({
		queryKey: ["approved-connection-request", accessRequestId],
		queryFn: () =>
			connectionApi.getConnectionAccessRequest(accessRequestId ?? ""),
		enabled: Boolean(accessRequestId),
	});
	const prepareConnect = useMutation({
		mutationFn: connectionApi.prepareConnectionAccess,
	});
	const requestReady = Boolean(
		approvedRequest.data?.id === accessRequestId &&
			approvedRequest.data?.state === "APPROVED_PENDING_CONNECTION" &&
			approvedRequest.data?.connectExpiresAt &&
			Date.parse(approvedRequest.data.connectExpiresAt) > Date.now() &&
			approvedRequest.data?.providerId === approvedProvider,
	);
	useEffect(() => {
		if (
			!requestReady ||
			!accessRequestId ||
			prepareAttempted.current === accessRequestId
		)
			return;
		prepareAttempted.current = accessRequestId;
		prepareConnect.mutate(accessRequestId);
	}, [accessRequestId, requestReady, prepareConnect.mutate]);
	const approvedAccessRequestId =
		requestReady &&
		prepareConnect.data?.requestId === accessRequestId &&
		prepareConnect.data?.providerId === approvedProvider &&
		Date.parse(prepareConnect.data?.connectExpiresAt ?? "") > Date.now()
			? accessRequestId
			: undefined;
	const [bulkUpgrade, setBulkUpgrade] = useState<{
		completed: number;
		failedConnectionIds: string[];
		running: boolean;
		total: number;
	} | null>(null);
	const callbackFailed =
		new URLSearchParams(window.location.search).get("oauth") ===
		"callback_failed";
	useEffect(() => {
		const search = new URLSearchParams(window.location.search);
		if (!["connect", "reauthorize"].includes(search.get("intent") ?? ""))
			return;
		const provider = search.get("provider");
		if (
			accessRequestId &&
			(approvedRequest.isPending ||
				(requestReady && !prepareConnect.isSuccess && !prepareConnect.isError))
		)
			return;
		if (!approvedAccessRequestId) {
			if (provider)
				setApprovalRequiredProvider(provider as ConnectorProviderId);
			return;
		}
		if (provider === "bitbucket") setBitbucketOpen(true);
		if (provider === "rehoboam") setRehoboamOpen(true);
		if (provider === "manhattan") setManhattanOpen(true);
		if (provider === "confluence") setConfluenceOpen(true);
		if (provider === "jira") setJiraOpen(true);
		if (provider === "jenkins-ci" || provider === "jenkins-release") {
			setJenkinsProviderId(provider);
			setJenkinsOpen(true);
		}
	}, [
		accessRequestId,
		approvedAccessRequestId,
		approvedRequest.isPending,
		requestReady,
		prepareConnect.isSuccess,
		prepareConnect.isError,
	]);
	const overview = useQuery({
		queryKey: ["connections"],
		queryFn: connectionApi.getConnections,
	});
	const accessRequests = useQuery({
		queryKey: ["connection-access-requests"],
		queryFn: connectionApi.listConnectionAccessRequests,
		refetchInterval: 30_000,
	});
	const oauth = useGithubOAuth();
	const reconnectOAuth = useMutation({
		mutationFn: (connectionId: string) =>
			connectionApi.reauthorizeProviderConnection({
				connectionId,
				body: { mode: "OAUTH" },
			}),
		onSuccess: (result) => {
			if ("authorizationUrl" in result)
				window.location.assign(result.authorizationUrl);
		},
	});
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
	const connectCredential = (body: ProviderCredentialRequest) =>
		reconnectTargetId
			? connectionApi.reauthorizeProviderConnection({
					connectionId: reconnectTargetId,
					body,
				})
			: connectionApi.connectProviderCredential({
					...body,
					accessRequestId: approvedAccessRequestId,
				});
	const connectBitbucket = async (accessToken: string) => {
		setBitbucketPending(true);
		setBitbucketError(null);
		try {
			await connectCredential({
				accessToken,
				providerId: "bitbucket",
			});
			setBitbucketOpen(false);
			setReconnectTargetId(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setBitbucketError(
				error instanceof Error ? error : new Error("Bitbucket 连接失败"),
			);
		} finally {
			setBitbucketPending(false);
		}
	};
	const connectRehoboam = async (accessToken: string) => {
		setRehoboamPending(true);
		setRehoboamError(null);
		try {
			await connectCredential({
				accessToken,
				providerId: "rehoboam",
			});
			setRehoboamOpen(false);
			setReconnectTargetId(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setRehoboamError(
				error instanceof Error ? error : new Error("Rehoboam 连接失败"),
			);
		} finally {
			setRehoboamPending(false);
		}
	};
	const connectManhattan = async (credential: {
		password: string;
		username: string;
	}) => {
		setManhattanPending(true);
		setManhattanError(null);
		try {
			await connectCredential({
				providerId: "manhattan",
				...credential,
			});
			setManhattanOpen(false);
			setReconnectTargetId(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setManhattanError(
				error instanceof Error ? error : new Error("Manhattan 连接失败"),
			);
		} finally {
			setManhattanPending(false);
		}
	};
	const connectJira = async (credential: {
		password: string;
		username: string;
	}) => {
		setJiraPending(true);
		setJiraError(null);
		try {
			await connectCredential({
				providerId: "jira",
				...credential,
			});
			setJiraOpen(false);
			setReconnectTargetId(null);
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
			await connectCredential({
				providerId: "confluence",
				...credential,
			});
			setConfluenceOpen(false);
			setReconnectTargetId(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setConfluenceError(
				error instanceof Error ? error : new Error("Confluence 连接失败"),
			);
		} finally {
			setConfluencePending(false);
		}
	};
	const connectDatalego = async () => {
		setDatalegoError(null);
		try {
			await connectCredential({ providerId: "datalego" });
			setReconnectTargetId(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setDatalegoError(
				error instanceof Error ? error : new Error("DataLego 连接失败"),
			);
		}
	};
	const connectJenkins = async (credential: {
		apiToken: string;
		username: string;
	}) => {
		setJenkinsPending(true);
		setJenkinsError(null);
		try {
			await connectCredential({
				providerId: jenkinsProviderId,
				...credential,
			});
			setJenkinsOpen(false);
			setReconnectTargetId(null);
			await queryClient.invalidateQueries({ queryKey: ["connections"] });
		} catch (error) {
			setJenkinsError(
				error instanceof Error
					? error
					: new Error(`${providerLabel(jenkinsProviderId)} 连接失败`),
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

	const beginOAuth = () => oauth.begin(undefined, approvedAccessRequestId);
	const openProviderCredential = (providerId: ConnectorProviderId) => {
		if (providerId === "bitbucket") setBitbucketOpen(true);
		else if (providerId === "datalego") void connectDatalego();
		else if (providerId === "rehoboam") setRehoboamOpen(true);
		else if (providerId === "manhattan") setManhattanOpen(true);
		else if (providerId === "jira") setJiraOpen(true);
		else if (providerId === "confluence") setConfluenceOpen(true);
		else if (providerId === "jenkins-ci" || providerId === "jenkins-release") {
			setJenkinsProviderId(providerId);
			setJenkinsOpen(true);
		} else beginOAuth();
	};
	const connectProvider = (providerId: ConnectorProviderId) => {
		if (!approvedAccessRequestId || approvedProvider !== providerId) {
			setRenewalTarget(null);
			setRenewalProviderId("");
			setReconnectTargetId(null);
			setRequestTargetProvider(providerId);
			setRequestTrigger((value) => value + 1);
			document
				.getElementById(`connection-access-${providerId}`)
				?.scrollIntoView?.({ behavior: "smooth", block: "start" });
			return;
		}
		openProviderCredential(providerId);
	};

	const data = overview.data?.overview;
	const previousActions = useCallback(
		(connectionId: string, consumerId: string) => {
			const grant = data?.grants.find(
				(entry) =>
					entry.connectionId === connectionId &&
					entry.consumerId === consumerId &&
					["ACTIVE", "PAUSED_CONNECTION", "PAUSED_CREDENTIAL"].includes(
						entry.status,
					),
			);
			return grant ? grant.actions : null;
		},
		[data?.grants],
	);
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
			initialActions: previousActions(
				candidates[0].id,
				data.consumers[0]?.id ?? "",
			),
			preview: null,
			reviewed: false,
		});
	}, [data, previousActions]);
	const visibleGrants = data
		? showHistory
			? data.grants
			: data.grants.filter((grant) => grant.status === "ACTIVE")
		: [];
	const bulkUpgradeConnectionIds = data
		? [
				...new Set(
					data.upgradeTasks
						.filter((task) => task.status === "PENDING_CONNECTION")
						.map((task) => task.connectionId),
				),
			]
		: [];
	const runBulkUpgrade = async (connectionIds: string[]) => {
		setUpgradeNotice(null);
		setBulkUpgrade({
			completed: 0,
			failedConnectionIds: [],
			running: true,
			total: connectionIds.length,
		});
		const failedConnectionIds: string[] = [];
		let completed = 0;
		for (const connectionId of connectionIds) {
			try {
				await connectionApi.upgradeProviderConnection(connectionId);
			} catch {
				failedConnectionIds.push(connectionId);
			}
			completed += 1;
			setBulkUpgrade({
				completed,
				failedConnectionIds: [...failedConnectionIds],
				running: true,
				total: connectionIds.length,
			});
		}
		const refreshed = await connectionApi.getConnections().catch(() => null);
		if (!refreshed) {
			setBulkUpgrade({
				completed,
				failedConnectionIds: [],
				running: false,
				total: connectionIds.length,
			});
			setUpgradeNotice(
				"批量升级请求已处理，但刷新结果失败；请刷新页面确认最新状态。",
			);
			return;
		}
		queryClient.setQueryData(["connections"], refreshed);
		const pendingConnectionIds = new Set(
			refreshed.overview.upgradeTasks
				.filter((task) => task.status === "PENDING_CONNECTION")
				.map((task) => task.connectionId),
		);
		const retryableFailedConnectionIds = failedConnectionIds.filter(
			(connectionId) => pendingConnectionIds.has(connectionId),
		);
		const needsAuthorization = refreshed.overview.upgradeTasks.filter(
			(task) => task.status === "PENDING_AUTHORIZATION",
		).length;
		setBulkUpgrade({
			completed,
			failedConnectionIds: retryableFailedConnectionIds,
			running: false,
			total: connectionIds.length,
		});
		setUpgradeNotice(
			`批量处理完成：${connectionIds.length - retryableFailedConnectionIds.length} 个连接已升级，${retryableFailedConnectionIds.length} 个失败，${needsAuthorization} 条授权待确认。`,
		);
	};
	return (
		<ConsoleShell>
			<PageHeader
				title="我的 Connection"
				action={
					<Button
						type="button"
						onClick={() => {
							const search = document.getElementById("connector-search");
							search?.scrollIntoView?.({ behavior: "smooth", block: "center" });
							search?.focus();
						}}
					>
						<Plus aria-hidden="true" size={17} />
						添加连接器
					</Button>
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
			{approvedRequest.isError ? (
				<PageError error={approvedRequest.error} />
			) : null}
			{prepareConnect.isError ? (
				<PageError error={prepareConnect.error} />
			) : null}
			{reconnectOAuth.isError ? (
				<PageError error={reconnectOAuth.error} />
			) : null}
			{bitbucketError ? <PageError error={bitbucketError} /> : null}
			{rehoboamError ? <PageError error={rehoboamError} /> : null}
			{manhattanError ? <PageError error={manhattanError} /> : null}
			{jiraError ? <PageError error={jiraError} /> : null}
			{confluenceError ? <PageError error={confluenceError} /> : null}
			{datalegoError ? <PageError error={datalegoError} /> : null}
			{jenkinsError ? <PageError error={jenkinsError} /> : null}
			{disconnect.isError ? <PageError error={disconnect.error} /> : null}
			{revokeGrant.isError ? <PageError error={revokeGrant.error} /> : null}
			{upgrade.isError ? <PageError error={upgrade.error} /> : null}
			{upgradeNotice ? (
				<p className="alert alert-success" role="status">
					{upgradeNotice}
				</p>
			) : null}
			{!data && !overview.isPending ? (
				<ConnectorManagementWorkspace
					accessRequests={accessRequests.data?.requests ?? []}
					accessRequestsError={accessRequests.error}
					accessRequestsPending={accessRequests.isPending}
					connections={[]}
					grants={[]}
					hasGrantHistory={false}
					onAuthorize={() => undefined}
					onConnect={connectProvider}
					onRenew={() => undefined}
					onRequestSubmitted={() => undefined}
					onDisconnect={() => undefined}
					onReconnect={() => undefined}
					onRevoke={() => undefined}
					revokePending={false}
					requestTrigger={requestTrigger}
					requestTargetProvider={requestTargetProvider}
					renewalTarget={null}
					renewalProviderId=""
					onShowHistoryChange={() => undefined}
					onUpgrade={() => undefined}
					showHistory={false}
					upgradingConnectionId={null}
				/>
			) : null}
			{data ? (
				<div className="content-stack">
					{data.upgradeTasks?.length ? (
						<section
							className="data-section"
							aria-labelledby="upgrade-tasks-title"
						>
							<div className="section-heading">
								<div>
									<h2 id="upgrade-tasks-title">需要处理的升级</h2>
									<p>完成连接升级后，可能还需要重新确认客户端授权。</p>
								</div>
								{bulkUpgradeConnectionIds.length >= 2 ||
								bulkUpgrade?.failedConnectionIds.length ? (
									<Button
										disabled={bulkUpgrade?.running || upgrade.isPending}
										onClick={() =>
											void runBulkUpgrade(
												bulkUpgrade?.failedConnectionIds.length
													? bulkUpgrade.failedConnectionIds
													: bulkUpgradeConnectionIds,
											)
										}
									>
										{bulkUpgrade?.running
											? `正在升级 ${bulkUpgrade.completed}/${bulkUpgrade.total}`
											: bulkUpgrade?.failedConnectionIds.length
												? `重试 ${bulkUpgrade.failedConnectionIds.length} 个失败项`
												: `一键升级 ${bulkUpgradeConnectionIds.length} 个连接`}
									</Button>
								) : null}
							</div>
							<div className="table-scroll">
								<table className="management-table">
									<thead>
										<tr>
											<th>平台</th>
											<th>客户端</th>
											<th>目标版本</th>
											<th>状态</th>
											<th className="table-action">操作</th>
										</tr>
									</thead>
									<tbody>
										{data.upgradeTasks.map((task) => (
											<tr key={task.taskId}>
												<td className="primary-cell">
													{providerLabel(task.providerId)}
												</td>
												<td>{task.consumerName}</td>
												<td>{task.targetProviderReleaseId}</td>
												<td>
													{task.status === "PENDING_CONNECTION"
														? "升级连接"
														: task.status === "PENDING_AUTHORIZATION"
															? "重新确认授权"
															: "已过期"}
												</td>
												<td className="table-action">
													{task.status === "PENDING_CONNECTION" ? (
														<Button
															disabled={
																upgrade.isPending || bulkUpgrade?.running
															}
															onClick={() => upgrade.mutate(task.connectionId)}
															variant="secondary"
														>
															{upgrade.isPending &&
															upgrade.variables === task.connectionId
																? "正在升级"
																: "处理升级"}
														</Button>
													) : task.status === "PENDING_AUTHORIZATION" ? (
														<button
															className="button button-secondary"
															type="button"
															onClick={() =>
																setAuthorization({
																	connectionId: task.connectionId,
																	consumerId: task.consumerId,
																	initialActions: previousActions(
																		task.connectionId,
																		task.consumerId,
																	),
																	preview: null,
																	reviewed: false,
																})
															}
														>
															确认授权
														</button>
													) : (
														<span>已过期</span>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</section>
					) : null}
					<ConnectorManagementWorkspace
						accessRequests={accessRequests.data?.requests ?? []}
						accessRequestsError={accessRequests.error}
						accessRequestsPending={accessRequests.isPending}
						connections={data.connections}
						grants={visibleGrants}
						hasGrantHistory={data.grants.length > 0}
						onAuthorize={(connectionId, consumerId) =>
							setAuthorization({
								connectionId,
								consumerId: consumerId ?? data.consumers[0]?.id ?? "",
								initialActions: previousActions(
									connectionId,
									consumerId ?? data.consumers[0]?.id ?? "",
								),
								preview: null,
								reviewed: false,
							})
						}
						onConnect={connectProvider}
						onRenew={(connection) => {
							if (!connection.accessAuthorization) return;
							setRenewalTarget(connection.accessAuthorization);
							setRenewalProviderId(connection.providerId);
							setRequestTargetProvider(connection.providerId);
							setRequestTrigger((value) => value + 1);
							document
								.getElementById(`connection-access-${connection.providerId}`)
								?.scrollIntoView?.({ behavior: "smooth", block: "start" });
						}}
						onRequestSubmitted={() => {
							setRenewalTarget(null);
							setRenewalProviderId("");
						}}
						onDisconnect={(connectionId) => {
							const connection = data.connections.find(
								(entry) => entry.id === connectionId,
							);
							if (
								window.confirm(
									`确认断开这个 ${providerLabel(connection?.providerId ?? "")} Connection？`,
								)
							)
								disconnect.mutate(connectionId);
						}}
						onReconnect={(connection) => {
							if (
								connection.status === "DISCONNECTED" &&
								connection.accessAuthorization?.state === "DISCONNECTED" &&
								(!connection.accessAuthorization.validUntil ||
									Date.parse(connection.accessAuthorization.validUntil) >
										Date.now())
							) {
								setReconnectTargetId(connection.id);
								if (connection.providerId === "github")
									reconnectOAuth.mutate(connection.id);
								else
									openProviderCredential(
										connection.providerId as ConnectorProviderId,
									);
							} else
								connectProvider(connection.providerId as ConnectorProviderId);
						}}
						requestTrigger={requestTrigger}
						requestTargetProvider={requestTargetProvider}
						renewalTarget={renewalTarget}
						renewalProviderId={renewalProviderId}
						onRevoke={(grantId) => revokeGrant.mutate(grantId)}
						revokePending={revokeGrant.isPending}
						onShowHistoryChange={setShowHistory}
						onUpgrade={(connectionId) => upgrade.mutate(connectionId)}
						showHistory={showHistory}
						upgradingConnectionId={
							upgrade.isPending ? (upgrade.variables ?? null) : null
						}
					/>
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
								initialActions={authorization.initialActions}
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
											initialActions: previousActions(
												authorization.connectionId,
												event.target.value,
											),
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
					if (!open) {
						setJenkinsError(null);
						setReconnectTargetId(null);
					}
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接 {providerLabel(jenkinsProviderId)}</DialogTitle>
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
						<label htmlFor="jenkins-username">Jenkins 用户名</label>
						<input
							autoComplete="username"
							defaultValue={overview.data?.account.email ?? ""}
							id="jenkins-username"
							maxLength={256}
							name="username"
							required
							type="text"
						/>
						<label htmlFor="jenkins-api-token">Jenkins API Token</label>
						<input
							autoComplete="off"
							id="jenkins-api-token"
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
				open={manhattanOpen}
				onOpenChange={(open) => {
					setManhattanOpen(open);
					if (!open) {
						setManhattanError(null);
						setReconnectTargetId(null);
					}
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接 Manhattan</DialogTitle>
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
							if (typeof username === "string" && typeof password === "string")
								void connectManhattan({ password, username });
						}}
					>
						<label htmlFor="manhattan-username">公司账号</label>
						<input
							autoComplete="username"
							defaultValue={overview.data?.account.email ?? ""}
							id="manhattan-username"
							maxLength={256}
							name="username"
							required
							type="text"
						/>
						<label htmlFor="manhattan-password">公司密码</label>
						<input
							autoComplete="current-password"
							id="manhattan-password"
							maxLength={1024}
							name="password"
							required
							type="password"
						/>
						<div className="dialog-actions">
							<Button type="submit" disabled={manhattanPending}>
								<KeyRound aria-hidden="true" size={17} />
								{manhattanPending ? "正在验证" : "连接"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={rehoboamOpen}
				onOpenChange={(open) => {
					setRehoboamOpen(open);
					if (!open) {
						setRehoboamError(null);
						setReconnectTargetId(null);
					}
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>连接 Rehoboam</DialogTitle>
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
							const accessToken = new FormData(event.currentTarget).get(
								"accessToken",
							);
							if (typeof accessToken === "string")
								void connectRehoboam(accessToken);
						}}
					>
						<label htmlFor="rehoboam-access-token">Rehoboam PAT</label>
						<input
							autoComplete="off"
							id="rehoboam-access-token"
							maxLength={8192}
							name="accessToken"
							required
							type="password"
						/>
						<div className="dialog-actions">
							<Button type="submit" disabled={rehoboamPending}>
								<KeyRound aria-hidden="true" size={17} />
								{rehoboamPending ? "正在验证" : "连接"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={approvalRequiredProvider !== null}
				onOpenChange={(open) => {
					if (!open) setApprovalRequiredProvider(null);
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>
							申请连接 {providerLabel(approvalRequiredProvider ?? "")}
						</DialogTitle>
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
					<p>连接外部账号前需要完成审批。</p>
					<Button
						onClick={() => {
							const providerId = approvalRequiredProvider;
							setApprovalRequiredProvider(null);
							if (providerId) connectProvider(providerId);
						}}
					>
						查看连接申请
					</Button>
				</DialogContent>
			</Dialog>
			<Dialog
				open={bitbucketOpen}
				onOpenChange={(open) => {
					setBitbucketOpen(open);
					if (!open) {
						setBitbucketError(null);
						setReconnectTargetId(null);
					}
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
					if (!open) {
						setConfluenceError(null);
						setReconnectTargetId(null);
					}
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
					if (!open) {
						setJiraError(null);
						setReconnectTargetId(null);
					}
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

function actionVersions(connection: Connection) {
	return [
		...new Set(
			connection.actionVersionIds.flatMap((id) => {
				const version = id.match(/@(v\d+)$/)?.[1];
				return version ? [version] : [];
			}),
		),
	].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function ConnectorManagementWorkspace(props: {
	accessRequests: AccessRequestsResponse["requests"];
	accessRequestsError: unknown;
	accessRequestsPending: boolean;
	connections: Connection[];
	grants: Grant[];
	hasGrantHistory: boolean;
	onAuthorize: (connectionId: string, consumerId?: string) => void;
	onConnect: (providerId: ConnectorProviderId) => void;
	onRenew: (connection: Connection) => void;
	onRequestSubmitted: () => void;
	onDisconnect: (connectionId: string) => void;
	onReconnect: (connection: Connection) => void;
	onRevoke: (grantId: string) => void;
	onShowHistoryChange: (show: boolean) => void;
	onUpgrade: (connectionId: string) => void;
	revokePending: boolean;
	requestTrigger: number;
	requestTargetProvider: string;
	renewalTarget: Connection["accessAuthorization"];
	renewalProviderId: string;
	showHistory: boolean;
	upgradingConnectionId: string | null;
}) {
	const activeConnections = props.connections.filter(
		(connection) => connection.status === "ACTIVE",
	);
	const requestedProvider = new URLSearchParams(window.location.search).get(
		"provider",
	);
	const initialProvider =
		connectorDefinitions.find((item) => item.providerId === requestedProvider)
			?.providerId ??
		activeConnections.find((connection) => connection.providerId === "github")
			?.providerId ??
		activeConnections[0]?.providerId ??
		connectorDefinitions[0]?.providerId ??
		"github";
	const [providerId, setProviderId] = useState(initialProvider);
	const [connectionId, setConnectionId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const visibleConnectors = connectorDefinitions.filter((connector) =>
		`${connector.name} ${connector.category} ${connector.description}`
			.toLowerCase()
			.includes(query.trim().toLowerCase()),
	);
	const connector =
		connectorDefinitions.find((item) => item.providerId === providerId) ??
		connectorDefinitions[0];
	const currentRequest = props.accessRequests.find(
		(item) =>
			item.providerId === connector?.providerId &&
			[
				"SUBMITTED",
				"IN_REVIEW",
				"ROUTING_BLOCKED",
				"APPROVED_PENDING_CONNECTION",
			].includes(item.state),
	);
	const accounts = props.connections
		.filter(
			(connection) =>
				connection.status === "ACTIVE" ||
				(connection.status === "DISCONNECTED" &&
					connection.accessAuthorization?.state === "DISCONNECTED" &&
					(!connection.accessAuthorization.validUntil ||
						Date.parse(connection.accessAuthorization.validUntil) >
							Date.now())),
		)
		.filter((connection) => connection.providerId === connector?.providerId);
	const selected =
		accounts.find((connection) => connection.id === connectionId) ??
		accounts[0];
	const grants = selected
		? props.grants.filter((grant) => grant.connectionId === selected.id)
		: [];
	const Icon = connector?.icon;
	const authorizationAvailable =
		selected?.status === "ACTIVE" &&
		!selected.requiresReconnect &&
		(!selected.accessAuthorization ||
			(selected.accessAuthorization.state === "ACTIVE" &&
				(!selected.accessAuthorization.validUntil ||
					Date.parse(selected.accessAuthorization.validUntil) > Date.now())));

	return (
		<section className="connection-management-workspace">
			<aside className="connection-connector-list">
				<label className="connector-search" htmlFor="connector-search">
					<Search aria-hidden="true" size={17} />
					<span className="sr-only">搜索连接器</span>
					<input
						id="connector-search"
						maxLength={120}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索连接器"
						type="search"
						value={query}
					/>
				</label>
				<strong className="connection-list-label">连接器</strong>
				{visibleConnectors.map((item) => {
					const count = activeConnections.filter(
						(connection) => connection.providerId === item.providerId,
					).length;
					const ItemIcon = item.icon;
					return (
						<button
							className={
								item.providerId === connector?.providerId ? "active" : ""
							}
							key={item.providerId}
							onClick={() => {
								setProviderId(item.providerId);
								setConnectionId(null);
							}}
							type="button"
						>
							<span className="connector-logo" aria-hidden="true">
								<ItemIcon size={19} />
							</span>
							<span>
								<b>{item.name}</b>
								<small>{count ? `已连接 ${count} 个账号` : "未连接"}</small>
							</span>
							<ChevronRight aria-hidden="true" size={16} />
						</button>
					);
				})}
			</aside>
			<div className="connection-provider-detail">
				<header className="connection-provider-header">
					{Icon ? (
						<span className="connector-logo">{<Icon size={20} />}</span>
					) : null}
					<div>
						<span>{connector?.category}</span>
						<h2>{connector?.name}</h2>
						<p>{connector?.description}</p>
					</div>
					{currentRequest?.state === "APPROVED_PENDING_CONNECTION" &&
					currentRequest.connectExpiresAt &&
					Date.parse(currentRequest.connectExpiresAt) > Date.now() ? (
						<a
							className="button button-primary"
							href={`/connection/connections?provider=${encodeURIComponent(providerId)}&intent=connect&accessRequestId=${encodeURIComponent(currentRequest.id)}`}
						>
							连接账号
						</a>
					) : (
						<Button
							variant={accounts.length ? "secondary" : "primary"}
							disabled={Boolean(currentRequest)}
							onClick={() => connector && props.onConnect(connector.providerId)}
						>
							{currentRequest?.state === "APPROVED_PENDING_CONNECTION"
								? "连接窗口已过期"
								: currentRequest
									? "审批中"
									: "申请连接"}
						</Button>
					)}
				</header>
				{connector ? (
					<AccessRequestPanel
						key={connector.providerId}
						onSubmitted={props.onRequestSubmitted}
						providerId={connector.providerId}
						renewalTarget={
							props.renewalProviderId === connector.providerId
								? (props.renewalTarget ?? null)
								: null
						}
						requests={props.accessRequests}
						requestsError={props.accessRequestsError}
						requestsPending={props.accessRequestsPending}
						startProviderId={props.requestTargetProvider}
						startSignal={props.requestTrigger}
					/>
				) : null}
				{selected ? (
					<div className="connection-account-workspace">
						<section className="connection-account-list">
							<div className="connection-subheading">
								<div>
									<strong>已连接账号</strong>
									<p>{accounts.length} 个账号</p>
								</div>
							</div>
							{accounts.map((account) => {
								const versions = actionVersions(account);
								return (
									<button
										className={account.id === selected.id ? "active" : ""}
										key={account.id}
										onClick={() => setConnectionId(account.id)}
										type="button"
									>
										<span className="connection-account-avatar">
											{account.displayName.slice(0, 1).toUpperCase()}
										</span>
										<span>
											<b>{account.displayName}</b>
											<small>{account.externalAccount}</small>
											{versions.length ? (
												<small>授权版本 {versions.join(", ")}</small>
											) : null}
											<small>
												{
													props.grants.filter(
														(grant) =>
															grant.connectionId === account.id &&
															grant.status === "ACTIVE",
													).length
												}{" "}
												个客户端
											</small>
										</span>
										<ChevronRight aria-hidden="true" size={16} />
									</button>
								);
							})}
						</section>
						<section className="connection-grant-list">
							<div className="connection-selected-account">
								<div>
									<span>客户端授权</span>
									<h2 className="sr-only">客户端授权</h2>
									<h3>{selected.displayName}</h3>
									<p>{selected.externalAccount}</p>
									{selected.accessAuthorization ? (
										<p className="connection-access-validity">
											{selected.accessAuthorization.state === "ACTIVE"
												? selected.accessAuthorization.validityKind ===
													"PERMANENT"
													? "审批：永久有效"
													: `审批有效至 ${new Date(selected.accessAuthorization.validUntil ?? "").toLocaleString()}`
												: `审批：${accessStateLabels[selected.accessAuthorization.state] ?? selected.accessAuthorization.state}`}
										</p>
									) : null}
								</div>
								<Status value={selected.status} />
							</div>
							<div className="connection-grant-toolbar">
								{props.hasGrantHistory ? (
									<label className="history-toggle">
										<input
											checked={props.showHistory}
											onChange={(event) =>
												props.onShowHistoryChange(event.target.checked)
											}
											type="checkbox"
										/>
										<span>显示历史授权</span>
									</label>
								) : (
									<span />
								)}
								<Button
									disabled={!authorizationAvailable}
									onClick={() => props.onAuthorize(selected.id)}
									title={authorizationAvailable ? "授权客户端" : "请先恢复连接"}
								>
									<Plus aria-hidden="true" size={15} />
									授权客户端
								</Button>
							</div>
							<div className="connection-grants">
								{grants.length ? (
									grants.map((grant) => (
										<div className="connection-grant-row" key={grant.id}>
											<span className="connection-client-avatar">
												{grant.consumerName.slice(0, 1).toUpperCase()}
											</span>
											<div>
												<strong>{grant.consumerName}</strong>
												<GrantPermissions grant={grant} />
											</div>
											<Status value={grant.status} />
											<Button
												variant="secondary"
												size="icon"
												disabled={
													grant.status !== "ACTIVE" || !authorizationAvailable
												}
												onClick={() =>
													props.onAuthorize(selected.id, grant.consumerId)
												}
												aria-label={`管理 ${grant.consumerName} 能力`}
												title="管理能力"
											>
												<SlidersHorizontal aria-hidden="true" size={16} />
											</Button>
											<Button
												variant="danger"
												size="icon"
												disabled={
													grant.status !== "ACTIVE" || props.revokePending
												}
												onClick={() => props.onRevoke(grant.id)}
												aria-label={`撤销 ${grant.consumerName}`}
												title="撤销授权"
											>
												<ShieldOff aria-hidden="true" size={16} />
											</Button>
										</div>
									))
								) : (
									<div className="connection-inline-empty">
										<ShieldOff aria-hidden="true" size={20} />
										<strong>还没有客户端授权</strong>
										<p>授权后，客户端才能通过此账号工作。</p>
									</div>
								)}
							</div>
							<div className="connection-account-actions">
								{!currentRequest &&
								selected.status === "ACTIVE" &&
								!selected.requiresReconnect &&
								["REAPPROVAL_REQUIRED", "SUSPENDED"].includes(
									selected.accessAuthorization?.state ?? "",
								) ? (
									<Button
										variant="secondary"
										onClick={() =>
											props.onConnect(
												selected.providerId as ConnectorProviderId,
											)
										}
									>
										申请重审
									</Button>
								) : null}
								{selected.status === "ACTIVE" &&
								!selected.requiresReconnect &&
								selected.accessAuthorization?.state === "EXPIRED" ? (
									<Button
										variant="secondary"
										onClick={() =>
											props.onConnect(
												selected.providerId as ConnectorProviderId,
											)
										}
									>
										重新申请
									</Button>
								) : null}
								{!currentRequest &&
								selected.status === "ACTIVE" &&
								!selected.requiresReconnect &&
								selected.accessAuthorization?.validityKind === "FINITE" &&
								selected.accessAuthorization.renewalOpensAt &&
								Date.parse(selected.accessAuthorization.renewalOpensAt) <=
									Date.now() &&
								selected.accessAuthorization.state === "ACTIVE" ? (
									<Button
										variant="secondary"
										onClick={() => props.onRenew(selected)}
									>
										申请续期
									</Button>
								) : null}
								{selected.requiresReconnect ? (
									selected.status === "DISCONNECTED" &&
									selected.accessAuthorization?.state === "DISCONNECTED" &&
									(!selected.accessAuthorization.validUntil ||
										Date.parse(selected.accessAuthorization.validUntil) >
											Date.now()) ? (
										<Button
											variant="secondary"
											onClick={() => props.onReconnect(selected)}
										>
											重新连接
										</Button>
									) : selected.accessAuthorization ? (
										<Button
											variant="secondary"
											onClick={() =>
												props.onConnect(
													selected.providerId as ConnectorProviderId,
												)
											}
										>
											重新申请
										</Button>
									) : (
										<Button
											variant="secondary"
											disabled={props.upgradingConnectionId === selected.id}
											onClick={() =>
												selected.providerId === "github"
													? props.onReconnect(selected)
													: props.onUpgrade(selected.id)
											}
										>
											{props.upgradingConnectionId === selected.id
												? "正在升级"
												: selected.providerId === "github"
													? "重新连接"
													: "升级连接"}
										</Button>
									)
								) : null}
								{selected.ownerType === "PERSONAL" &&
								selected.status === "ACTIVE" ? (
									<Button
										variant="danger"
										onClick={() => props.onDisconnect(selected.id)}
									>
										断开 Connection
									</Button>
								) : null}
							</div>
						</section>
					</div>
				) : (
					<EmptyState title={`还没有 ${connector?.name} Connection`}>
						连接后，账号和客户端授权会在这里统一管理。
					</EmptyState>
				)}
			</div>
		</section>
	);
}

export function PreviewContent(props: {
	busy: boolean;
	initialActions?: Grant["actions"] | null;
	onConfirm: () => void;
	onReview?: (actionVersionIds: string[]) => void;
	reviewed?: boolean;
	value: AuthorizationPreviewResponse;
}) {
	const defaultSelection =
		props.initialActions !== undefined && props.initialActions !== null
			? props.value.preview.actions
					.filter((action) =>
						props.initialActions?.some(
							(previous) =>
								previous.name === action.name &&
								previous.effect === action.effect,
						),
					)
					.map((action) => action.id)
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
