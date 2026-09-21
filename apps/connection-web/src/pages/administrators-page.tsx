import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldMinus } from "lucide-react";

import { connectionApi } from "../api";
import { ConsoleShell, PageError } from "../shell";
import { EmptyState, PageHeader } from "../views";

export function AdministratorsPage() {
	const queryClient = useQueryClient();
	const administrators = useQuery({
		queryKey: ["administrators"],
		queryFn: connectionApi.listAdministrators,
	});
	const upgrades = useQuery({
		queryKey: ["provider-upgrades"],
		queryFn: connectionApi.listProviderUpgradeCampaigns,
		enabled: administrators.isSuccess,
	});
	const grant = useMutation({
		mutationFn: connectionApi.grantAdministrator,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["administrators"] }),
	});
	const revoke = useMutation({
		mutationFn: connectionApi.revokeAdministrator,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["administrators"] }),
	});

	return (
		<ConsoleShell>
			<PageHeader title="Connection 管理员" />
			{administrators.isError ? (
				<PageError error={administrators.error} />
			) : null}
			{upgrades.isError ? <PageError error={upgrades.error} /> : null}
			{grant.isError ? <PageError error={grant.error} /> : null}
			{revoke.isError ? <PageError error={revoke.error} /> : null}
			{administrators.isError ? null : (
				<section className="data-section">
					{administrators.data?.administrators.length ? (
						<div className="table-scroll">
							<table className="management-table">
								<thead>
									<tr>
										<th>姓名</th>
										<th>公司账号</th>
										<th>角色</th>
										<th className="table-action">操作</th>
									</tr>
								</thead>
								<tbody>
									{administrators.data.administrators.map((person) => (
										<tr key={person.principalId}>
											<td className="primary-cell">{person.displayName}</td>
											<td>{person.email ?? "公司账号"}</td>
											<td>
												<span
													className={`status ${person.isAdministrator ? "status-active" : "status-muted"}`}
												>
													{person.isAdministrator ? "管理员" : "普通用户"}
												</span>
											</td>
											<td className="table-action">
												{person.isAdministrator ? (
													<button
														className="button button-danger"
														type="button"
														onClick={() => revoke.mutate(person.principalId)}
													>
														<ShieldMinus aria-hidden="true" size={16} />
														移除管理员
													</button>
												) : (
													<button
														className="button button-secondary"
														type="button"
														onClick={() => grant.mutate(person.principalId)}
													>
														<ShieldCheck aria-hidden="true" size={16} />
														设为管理员
													</button>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : administrators.isPending ? (
						<div
							className="skeleton-block"
							role="status"
							aria-label="正在加载"
						/>
					) : (
						<EmptyState title="没有可管理的员工">
							员工首次登录 Connection 后会出现在这里。
						</EmptyState>
					)}
				</section>
			)}
			{upgrades.isError ? null : (
				<section
					className="data-section"
					aria-labelledby="provider-upgrades-title"
				>
					<div className="section-heading">
						<div>
							<h2 id="provider-upgrades-title">Provider 升级</h2>
							<p>需要使用者操作的版本迁移及完成进度。</p>
						</div>
					</div>
					{upgrades.data?.campaigns.length ? (
						<div className="table-scroll">
							<table className="management-table">
								<thead>
									<tr>
										<th>Provider</th>
										<th>版本</th>
										<th>原因</th>
										<th>待处理</th>
										<th>已完成</th>
										<th>已失效</th>
										<th>截止时间</th>
									</tr>
								</thead>
								<tbody>
									{upgrades.data.campaigns.map((campaign) => (
										<tr key={campaign.id}>
											<td className="primary-cell">{campaign.providerId}</td>
											<td>
												{campaign.sourceProviderReleaseId} →{" "}
												{campaign.targetProviderReleaseId}
											</td>
											<td>{campaign.reason}</td>
											<td>
												{campaign.pendingCount} / {campaign.totalCount}
											</td>
											<td>{campaign.completedCount}</td>
											<td>{campaign.expiredCount}</td>
											<td>
												{campaign.deadlineAt
													? new Date(campaign.deadlineAt).toLocaleString()
													: "未设置"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : upgrades.isPending ? (
						<div
							className="skeleton-block"
							role="status"
							aria-label="正在加载"
						/>
					) : (
						<EmptyState title="没有待跟踪的 Provider 升级">
							需要使用者操作的发布会显示在这里。
						</EmptyState>
					)}
				</section>
			)}
		</ConsoleShell>
	);
}
