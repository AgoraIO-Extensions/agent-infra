import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Copy, PowerOff, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { connectionApi } from "../api";
import { ConsoleShell, PageError } from "../shell";
import { EmptyState, PageHeader } from "../views";

export function PatConsumersPage() {
	const queryClient = useQueryClient();
	const [consumerId, setConsumerId] = useState("");
	const [consumerName, setConsumerName] = useState("");
	const [callbackUrl, setCallbackUrl] = useState("");
	const [issuedSecret, setIssuedSecret] = useState("");
	const [declarationConsumerId, setDeclarationConsumerId] = useState("");
	const [providerReleaseId, setProviderReleaseId] = useState("");
	const [selectedActions, setSelectedActions] = useState<Set<string>>(
		() => new Set(),
	);
	const [actionQuery, setActionQuery] = useState("");
	const [actionEffect, setActionEffect] = useState<"ALL" | "READ" | "WRITE">(
		"ALL",
	);
	const consumers = useQuery({
		queryKey: ["pat-consumers"],
		queryFn: connectionApi.listPatConsumers,
	});
	const register = useMutation({
		mutationFn: connectionApi.registerPatConsumer,
		onSuccess: async ({ issued }) => {
			setIssuedSecret(issued.secret);
			await queryClient.invalidateQueries({ queryKey: ["pat-consumers"] });
		},
	});
	const disable = useMutation({
		mutationFn: connectionApi.disablePatConsumer,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["pat-consumers"] }),
	});
	const declarationOptions = useQuery({
		queryKey: ["consumer-declaration-options", declarationConsumerId],
		queryFn: () =>
			connectionApi.getConsumerDeclarationOptions(declarationConsumerId),
		enabled: Boolean(declarationConsumerId),
	});
	useEffect(() => {
		const first = declarationOptions.data?.providers[0];
		setProviderReleaseId(first?.providerReleaseId ?? "");
		setSelectedActions(new Set());
	}, [declarationOptions.data]);
	const provider = declarationOptions.data?.providers.find(
		(item) => item.providerReleaseId === providerReleaseId,
	);
	const visibleActions = useMemo(() => {
		const query = actionQuery.trim().toLowerCase();
		return (provider?.actions ?? []).filter(
			(action) =>
				(actionEffect === "ALL" || action.effect === actionEffect) &&
				(!query ||
					action.name.toLowerCase().includes(query) ||
					action.description.toLowerCase().includes(query)),
		);
	}, [actionEffect, actionQuery, provider]);
	const publish = useMutation({
		mutationFn: () =>
			connectionApi.publishConsumerDeclaration(declarationConsumerId, {
				actionVersionIds: [...selectedActions].sort(),
				providerReleaseId,
			}),
		onSuccess: () => setDeclarationConsumerId(""),
	});

	return (
		<ConsoleShell>
			<PageHeader title="Agent 接入" />
			{consumers.isError ? <PageError error={consumers.error} /> : null}
			{register.isError ? <PageError error={register.error} /> : null}
			{disable.isError ? <PageError error={disable.error} /> : null}
			{declarationOptions.isError ? (
				<PageError error={declarationOptions.error} />
			) : null}
			{publish.isError ? <PageError error={publish.error} /> : null}
			<section className="toolbar-section">
				<form
					className="form-stack"
					onSubmit={(event) => {
						event.preventDefault();
						setIssuedSecret("");
						register.mutate({ callbackUrl, consumerId, consumerName });
					}}
				>
					<label htmlFor="consumer-id">Consumer ID</label>
					<input
						id="consumer-id"
						required
						pattern="[a-z0-9][a-z0-9-]{2,79}"
						value={consumerId}
						onChange={(event) => setConsumerId(event.target.value)}
					/>
					<label htmlFor="consumer-name">Agent 名称</label>
					<input
						id="consumer-name"
						required
						maxLength={100}
						value={consumerName}
						onChange={(event) => setConsumerName(event.target.value)}
					/>
					<label htmlFor="consumer-callback">Callback URL</label>
					<input
						id="consumer-callback"
						type="url"
						required
						placeholder="https://agent.example/connection/callback"
						value={callbackUrl}
						onChange={(event) => setCallbackUrl(event.target.value)}
					/>
					<button className="button button-primary" type="submit">
						<Bot aria-hidden="true" size={16} />
						注册 Agent
					</button>
				</form>
				{issuedSecret ? (
					<div className="secret-callout" role="status">
						<strong>服务凭据仅显示一次</strong>
						<code>{issuedSecret}</code>
						<button
							className="button button-secondary"
							type="button"
							onClick={() => navigator.clipboard.writeText(issuedSecret)}
						>
							<Copy aria-hidden="true" size={16} />
							复制
						</button>
					</div>
				) : null}
			</section>
			<section className="data-section">
				{consumers.data?.consumers.length ? (
					<div className="table-scroll">
						<table className="management-table">
							<thead>
								<tr>
									<th>Agent</th>
									<th>Consumer ID</th>
									<th>Callback</th>
									<th>状态</th>
									<th className="table-action">操作</th>
								</tr>
							</thead>
							<tbody>
								{consumers.data.consumers.map((consumer) => (
									<tr key={consumer.consumerId}>
										<td className="primary-cell">{consumer.consumerName}</td>
										<td>
											<code>{consumer.consumerId}</code>
										</td>
										<td>{consumer.callbackUrl}</td>
										<td>{consumer.status === "ACTIVE" ? "启用" : "停用"}</td>
										<td className="table-action">
											{consumer.status === "ACTIVE" ? (
												<div className="row-actions">
													<button
														className="button button-secondary"
														type="button"
														onClick={() =>
															setDeclarationConsumerId(consumer.consumerId)
														}
													>
														<SlidersHorizontal aria-hidden="true" size={16} />
														配置能力
													</button>
													<button
														className="button button-danger"
														type="button"
														onClick={() => disable.mutate(consumer.consumerId)}
													>
														<PowerOff aria-hidden="true" size={16} />
														停用
													</button>
												</div>
											) : null}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState title="还没有 Agent">
						注册后才能发起用户级 PAT 绑定。
					</EmptyState>
				)}
			</section>
			{declarationConsumerId && declarationOptions.data ? (
				<section className="data-section content-stack">
					<div className="section-heading">
						<div>
							<h2>配置 {declarationOptions.data.consumer.name} 能力</h2>
							<p>Declaration 是可申请上限，不会直接授权外部账号。</p>
						</div>
						<button
							className="button button-secondary"
							type="button"
							onClick={() => setDeclarationConsumerId("")}
						>
							关闭
						</button>
					</div>
					<div className="permission-controls">
						<select
							aria-label="Provider"
							value={providerReleaseId}
							onChange={(event) => {
								setProviderReleaseId(event.target.value);
								setSelectedActions(new Set());
							}}
						>
							{declarationOptions.data.providers.map((item) => (
								<option
									key={item.providerReleaseId}
									value={item.providerReleaseId}
								>
									{item.providerId}
								</option>
							))}
						</select>
						<input
							aria-label="搜索能力"
							placeholder="搜索 Action"
							value={actionQuery}
							onChange={(event) => setActionQuery(event.target.value)}
						/>
						<select
							aria-label="能力类型"
							value={actionEffect}
							onChange={(event) =>
								setActionEffect(event.target.value as "ALL" | "READ" | "WRITE")
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
								setSelectedActions(
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
							onClick={() => setSelectedActions(new Set())}
						>
							清空
						</button>
						<span>{selectedActions.size} 项</span>
					</div>
					<ul className="permission-list">
						{visibleActions.map((action) => (
							<li key={action.id}>
								<label className="permission-option">
									<input
										checked={selectedActions.has(action.id)}
										type="checkbox"
										onChange={(event) =>
											setSelectedActions((current) => {
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
					<button
						className="button button-primary"
						type="button"
						disabled={selectedActions.size === 0 || publish.isPending}
						onClick={() => publish.mutate()}
					>
						{publish.isPending ? "正在发布" : "发布 Declaration"}
					</button>
				</section>
			) : null}
		</ConsoleShell>
	);
}
