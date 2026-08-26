import type { SharedScope } from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Link2,
	Pencil,
	Plus,
	Trash2,
	UserCheck,
	UserMinus,
} from "lucide-react";
import type { FormEvent } from "react";

import { connectionApi } from "../api";
import { useGithubOAuth } from "../github-oauth";
import { ConsoleShell, PageError } from "../shell";
import { EmptyState, PageHeader, Status } from "../views";

export function SharedConnectionsPage() {
	const queryClient = useQueryClient();
	const shared = useQuery({
		queryKey: ["shared-connections"],
		queryFn: connectionApi.getSharedConnections,
	});
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["shared-connections"] });
	const create = useMutation({
		mutationFn: connectionApi.createSharedScope,
		onSuccess: refresh,
	});
	const rename = useMutation({
		mutationFn: ({
			displayName,
			sharedScopeId,
		}: {
			displayName: string;
			sharedScopeId: string;
		}) => connectionApi.renameSharedScope(sharedScopeId, displayName),
		onSuccess: refresh,
	});
	const grant = useMutation({
		mutationFn: ({
			principalId,
			sharedScopeId,
		}: {
			principalId: string;
			sharedScopeId: string;
		}) => connectionApi.grantSharedScopePrincipal(sharedScopeId, principalId),
		onSuccess: refresh,
	});
	const revoke = useMutation({
		mutationFn: ({
			principalId,
			sharedScopeId,
		}: {
			principalId: string;
			sharedScopeId: string;
		}) => connectionApi.revokeSharedScopePrincipal(sharedScopeId, principalId),
		onSuccess: refresh,
	});
	const disconnect = useMutation({
		mutationFn: connectionApi.disconnectSharedConnection,
		onSuccess: refresh,
	});
	const oauth = useGithubOAuth();
	const beginOAuth = (sharedScopeId: string) => oauth.begin(sharedScopeId);
	const onCreate = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = event.currentTarget;
		create.mutate(String(new FormData(form).get("displayName") ?? ""), {
			onSuccess: () => form.reset(),
		});
	};

	const overview = shared.data?.overview;
	return (
		<ConsoleShell>
			<PageHeader title="共享 Connection" />
			{shared.isError ? <PageError error={shared.error} /> : null}
			{create.isError ? <PageError error={create.error} /> : null}
			{oauth.isError ? <PageError error={oauth.error} /> : null}
			{rename.isError ? <PageError error={rename.error} /> : null}
			{grant.isError ? <PageError error={grant.error} /> : null}
			{revoke.isError ? <PageError error={revoke.error} /> : null}
			{disconnect.isError ? <PageError error={disconnect.error} /> : null}
			{shared.isError ? null : (
				<section className="toolbar-section">
					<form className="inline-form" onSubmit={onCreate}>
						<div className="field-grow">
							<label htmlFor="scope-name">共享组名称</label>
							<input
								id="scope-name"
								name="displayName"
								maxLength={120}
								placeholder="例如：中国研发"
								required
							/>
						</div>
						<button
							className="button button-primary"
							type="submit"
							disabled={create.isPending}
						>
							<Plus aria-hidden="true" size={17} />
							创建共享组
						</button>
					</form>
				</section>
			)}

			{shared.isPending ? (
				<div className="skeleton-block" role="status" aria-label="正在加载" />
			) : null}
			{overview?.scopes.length ? (
				<div className="scope-list">
					{overview.scopes.map((scope) => (
						<SharedScopeSection
							key={scope.sharedScopeId}
							scope={scope}
							principals={overview.principals}
							onConnect={() => beginOAuth(scope.sharedScopeId)}
							onDisconnect={(connectionId) => disconnect.mutate(connectionId)}
							onGrant={(principalId) =>
								grant.mutate({
									principalId,
									sharedScopeId: scope.sharedScopeId,
								})
							}
							onRename={(displayName) =>
								rename.mutate({
									displayName,
									sharedScopeId: scope.sharedScopeId,
								})
							}
							onRevoke={(principalId) =>
								revoke.mutate({
									principalId,
									sharedScopeId: scope.sharedScopeId,
								})
							}
						/>
					))}
				</div>
			) : shared.isPending || shared.isError ? null : (
				<EmptyState title="还没有共享组">
					创建共享组后即可连接公司 GitHub 账号并分配使用资格。
				</EmptyState>
			)}
		</ConsoleShell>
	);
}

export function SharedScopeSection(props: {
	onConnect: () => void;
	onDisconnect: (connectionId: string) => void;
	onGrant: (principalId: string) => void;
	onRename: (displayName: string) => void;
	onRevoke: (principalId: string) => void;
	principals: Array<{
		displayName: string;
		email: string | null;
		principalId: string;
	}>;
	scope: SharedScope;
}) {
	return (
		<section className="scope-section">
			<div className="scope-heading">
				<div>
					<div className="connection-title-line">
						<h2>{props.scope.displayName}</h2>
						<Status value={props.scope.state} />
					</div>
					<p>
						{props.scope.connections.length} 个 GitHub 账号，
						{props.scope.members.length} 名可用员工
					</p>
				</div>
				<div className="row-actions">
					<button
						className="button button-primary"
						type="button"
						onClick={props.onConnect}
					>
						<Link2 aria-hidden="true" size={16} />
						连接 GitHub
					</button>
					<details className="rename-details">
						<summary className="button button-secondary">
							<Pencil aria-hidden="true" size={16} />
							改名
						</summary>
						<form
							className="rename-form"
							onSubmit={(event) => {
								event.preventDefault();
								props.onRename(
									String(
										new FormData(event.currentTarget).get("displayName") ?? "",
									),
								);
							}}
						>
							<label htmlFor={`rename-${props.scope.sharedScopeId}`}>
								共享组名称
							</label>
							<input
								id={`rename-${props.scope.sharedScopeId}`}
								key={`${props.scope.sharedScopeId}-${props.scope.displayName}`}
								name="displayName"
								defaultValue={props.scope.displayName}
								maxLength={120}
								required
							/>
							<button className="button button-primary" type="submit">
								保存
							</button>
						</form>
					</details>
				</div>
			</div>

			<div className="connection-list inset-list">
				{props.scope.connections.length ? (
					props.scope.connections.map((connection) => (
						<div className="connection-row compact-row" key={connection.id}>
							<div className="connection-main">
								<strong>{connection.displayName}</strong>
								<p>{connection.externalAccount}</p>
							</div>
							<Status value={connection.status} />
							{connection.status === "ACTIVE" ? (
								<button
									className="icon-button danger"
									type="button"
									onClick={() => props.onDisconnect(connection.id)}
									aria-label={`断开 ${connection.displayName}`}
									title="断开共享 Connection"
								>
									<Trash2 aria-hidden="true" size={17} />
								</button>
							) : null}
						</div>
					))
				) : (
					<p className="inline-empty">尚未连接 GitHub 账号</p>
				)}
			</div>

			<div className="section-heading compact-heading">
				<div>
					<h3>可使用此 Connection 的员工</h3>
					<p>仅显示至少登录过一次 Connection 的员工。</p>
				</div>
			</div>
			<div className="table-scroll">
				<table className="management-table">
					<thead>
						<tr>
							<th>姓名</th>
							<th>公司账号</th>
							<th>资格</th>
							<th className="table-action">操作</th>
						</tr>
					</thead>
					<tbody>
						{props.principals.map((person) => {
							const eligible = props.scope.members.includes(person.principalId);
							return (
								<tr key={person.principalId}>
									<td className="primary-cell">{person.displayName}</td>
									<td>{person.email ?? "公司账号"}</td>
									<td>
										<span
											className={`status ${eligible ? "status-active" : "status-muted"}`}
										>
											{eligible ? "可使用" : "不可使用"}
										</span>
									</td>
									<td className="table-action">
										<button
											className={`button ${eligible ? "button-danger" : "button-secondary"}`}
											type="button"
											onClick={() =>
												eligible
													? props.onRevoke(person.principalId)
													: props.onGrant(person.principalId)
											}
										>
											{eligible ? (
												<UserMinus aria-hidden="true" size={16} />
											) : (
												<UserCheck aria-hidden="true" size={16} />
											)}
											{eligible ? "移除资格" : "授予资格"}
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}
