import type { AuthorizationPreviewResponse } from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, ShieldOff, X } from "lucide-react";
import { useState } from "react";

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
import { ConnectionsView, EmptyState, PageHeader, Status } from "../views";

export function ConnectionsPage() {
	const queryClient = useQueryClient();
	const [authorization, setAuthorization] = useState<{
		connectionId: string;
		consumerId: string;
		preview: AuthorizationPreviewResponse | null;
	} | null>(null);
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
	return (
		<ConsoleShell>
			<PageHeader
				title="我的 Connection"
				action={
					<Button type="button" onClick={beginOAuth}>
						<Plus aria-hidden="true" size={17} />
						连接 GitHub
					</Button>
				}
			/>
			{overview.isPending ? (
				<div className="skeleton-block" role="status" aria-label="正在加载" />
			) : null}
			{overview.isError ? <PageError error={overview.error} /> : null}
			{oauth.isError ? <PageError error={oauth.error} /> : null}
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
								if (window.confirm("确认断开这个 GitHub Connection？")) {
									disconnect.mutate(connectionId);
								}
							}}
							onReconnect={beginOAuth}
						/>
					</section>

					<section className="data-section" aria-labelledby="grants-title">
						<div className="section-heading">
							<div>
								<h2 id="grants-title">客户端授权</h2>
								<p>每个 Consumer 独立授权，可随时撤销。</p>
							</div>
						</div>
						{data.grants.length ? (
							<div className="table-scroll">
								<table>
									<thead>
										<tr>
											<th>Consumer</th>
											<th>状态</th>
											<th>Action 数</th>
											<th className="table-action">操作</th>
										</tr>
									</thead>
									<tbody>
										{data.grants.map((grant) => (
											<tr key={grant.id}>
												<td className="primary-cell">{grant.consumerName}</td>
												<td>
													<Status value={grant.status} />
												</td>
												<td>{grant.actionVersionIds.length}</td>
												<td className="table-action">
													<Button
														variant="danger"
														size="icon"
														type="button"
														onClick={() => revokeGrant.mutate(grant.id)}
														aria-label={`撤销 ${grant.consumerName}`}
														title="撤销授权"
													>
														<ShieldOff aria-hidden="true" size={17} />
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<EmptyState title="还没有客户端授权">
								从上方 Connection 选择 Consumer 并确认授权。
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
								<label htmlFor="consumer">Consumer</label>
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
