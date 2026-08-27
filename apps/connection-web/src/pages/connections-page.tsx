import type { AuthorizationPreviewResponse } from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, KeyRound, Plus, ShieldOff, X } from "lucide-react";
import { type FormEvent, useState } from "react";

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
	const [authorization, setAuthorization] = useState<{
		connectionId: string;
		consumerId: string;
		preview: AuthorizationPreviewResponse | null;
	} | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [bitbucketOpen, setBitbucketOpen] = useState(false);
	const [bitbucketPending, setBitbucketPending] = useState(false);
	const [bitbucketError, setBitbucketError] = useState<Error | null>(null);
	const [jiraOpen, setJiraOpen] = useState(false);
	const [jiraPending, setJiraPending] = useState(false);
	const [jiraError, setJiraError] = useState<Error | null>(null);
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
	const preview = useMutation({
		mutationFn: connectionApi.createAuthorizationPreview,
		onSuccess: (value) =>
			setAuthorization((current) =>
				current ? { ...current, preview: value } : current,
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
				<div className="skeleton-block" role="status" aria-label="正在加载" />
			) : null}
			{overview.isError ? <PageError error={overview.error} /> : null}
			{oauth.isError ? <PageError error={oauth.error} /> : null}
			{bitbucketError ? <PageError error={bitbucketError} /> : null}
			{jiraError ? <PageError error={jiraError} /> : null}
			{disconnect.isError ? <PageError error={disconnect.error} /> : null}
			{revokeGrant.isError ? <PageError error={revokeGrant.error} /> : null}
			{data ? (
				<div className="content-stack">
					<section className="data-section">
						<ConnectionsView
							connections={data.connections}
							onAuthorize={(connectionId) =>
								setAuthorization({
									connectionId,
									consumerId: data.consumers[0]?.id ?? "",
									preview: null,
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
							onReconnect={(connectionId) => {
								const connection = data.connections.find(
									(entry) => entry.id === connectionId,
								);
								if (connection?.providerId === "bitbucket") {
									setBitbucketOpen(true);
								} else if (connection?.providerId === "jira") {
									setJiraOpen(true);
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
													<Button
														variant="danger"
														size="icon"
														type="button"
														disabled={
															grant.status !== "ACTIVE" || revokeGrant.isPending
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
								value={authorization.preview}
								busy={confirm.isPending}
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
	onConfirm: () => void;
	value: AuthorizationPreviewResponse;
}) {
	return (
		<div className="compact content-stack">
			<div className="account-switch">
				<strong>{props.value.preview.targetConnection.externalAccount}</strong>
				<span>{props.value.preview.consumer.name}</span>
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
			<div className="dialog-actions">
				<Button type="button" disabled={props.busy} onClick={props.onConfirm}>
					<Check aria-hidden="true" size={17} />
					{props.busy ? "正在确认" : "确认授权"}
				</Button>
			</div>
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
