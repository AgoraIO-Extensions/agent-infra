import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Copy, PowerOff } from "lucide-react";
import { useState } from "react";

import { connectionApi } from "../api";
import { ConsoleShell, PageError } from "../shell";
import { EmptyState, PageHeader } from "../views";

export function PatConsumersPage() {
	const queryClient = useQueryClient();
	const [consumerId, setConsumerId] = useState("");
	const [consumerName, setConsumerName] = useState("");
	const [callbackUrl, setCallbackUrl] = useState("");
	const [issuedSecret, setIssuedSecret] = useState("");
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

	return (
		<ConsoleShell>
			<PageHeader title="Agent 接入" />
			{consumers.isError ? <PageError error={consumers.error} /> : null}
			{register.isError ? <PageError error={register.error} /> : null}
			{disable.isError ? <PageError error={disable.error} /> : null}
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
												<button
													className="button button-danger"
													type="button"
													onClick={() => disable.mutate(consumer.consumerId)}
												>
													<PowerOff aria-hidden="true" size={16} />
													停用
												</button>
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
		</ConsoleShell>
	);
}
