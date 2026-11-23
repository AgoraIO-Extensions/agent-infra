import {
	ExternalServiceReceipt,
	ExternalServiceView,
} from "@agent-infra/contracts/pilot";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select";
import { useApplicationSession } from "../../features/application-shell";
import {
	listExternalServicesV2,
	manageExternalServiceV2,
	saveExternalServiceCandidateV2,
} from "../../pilot/generated-v2";

export const Route = createFileRoute("/admin/external-services")({
	component: ExternalServicesPage,
});
function ExternalServicesPage() {
	const { identityKey, session } = useApplicationSession();
	return (
		<main className="platform-content management-content">
			<h1>外部服务</h1>
			{session.user.roles.includes("system_admin") ? (
				<ServiceSettings key={identityKey} />
			) : (
				<Alert tone="warn">需要系统管理员权限。</Alert>
			)}
		</main>
	);
}
async function readResult(
	result: Promise<{ data?: unknown; response?: Response }>,
) {
	const { response, data } = await result;
	if (!response?.ok)
		throw Error(
			response?.status === 409
				? "配置版本已改变，请刷新后重试。"
				: response?.status === 403
					? "需要系统管理员权限。"
					: "请求失败，请核对地址、凭据及服务状态。",
		);
	return data;
}
function ServiceSettings() {
	const [snapshot, setSnapshot] =
		useState<ReturnType<typeof ExternalServiceView.parse>>();
	const [id, setId] = useState("relay");
	const [endpoint, setEndpoint] = useState("");
	const [url, setUrl] = useState("");
	const [credential, setCredential] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const selected = snapshot?.services.find((item) => item.id === id);
	const refresh = useCallback(
		async () =>
			setSnapshot(
				ExternalServiceView.parse(await readResult(listExternalServicesV2())),
			),
		[],
	);
	useEffect(() => {
		void refresh().catch(() => setMessage("读取配置失败。"));
	}, [refresh]);
	async function action(
		type: "save" | "test" | "enable" | "disable" | "discover",
	) {
		setBusy(true);
		setMessage("");
		try {
			const revision = selected?.revision ?? 0;
			const result = ExternalServiceReceipt.parse(
				type === "save"
					? await readResult(
							saveExternalServiceCandidateV2({
								body: {
									id,
									expectedRevision: revision,
									url,
									credential,
									modelEndpointId: selected?.modelEndpointId ?? endpoint,
								},
							}),
						)
					: await readResult(
							manageExternalServiceV2({
								body: {
									id,
									revision:
										type === "discover" ? (selected?.active ?? 0) : revision,
									action: type,
								},
							}),
						),
			);
			if (type === "save") setCredential("");
			setMessage(
				result.manifest
					? "连接成功 · 协议 v" +
							result.manifest.schemaVersion +
							" · " +
							result.manifest.capabilities.join("、")
					: result.discovery
						? "当前账号可用授权：" +
							(result.discovery.items
								.map((item) => item.displayName)
								.join("、") || "无")
						: "操作已保存",
			);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "操作失败");
		} finally {
			await refresh().catch(() => setSnapshot(undefined));
			setBusy(false);
		}
	}
	return (
		<div className="grid max-w-3xl gap-6">
			<section className="grid gap-3">
				<h2>服务实例</h2>
				<Label htmlFor="external-service-select">
					选择已登记实例
					<NativeSelect
						id="external-service-select"
						disabled={busy}
						value={selected?.id ?? ""}
						onChange={(e) => {
							const next = snapshot?.services.find(
								(item) => item.id === e.target.value,
							);
							setId(next?.id ?? "");
							setUrl(next?.url ?? "");
							setEndpoint(next?.modelEndpointId ?? "");
							setCredential("");
							setMessage("");
						}}
					>
						<NativeSelectOption value="">新实例</NativeSelectOption>
						{snapshot?.services.map((s) => (
							<NativeSelectOption value={s.id} key={s.id}>
								{s.id}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Label>
				<Label htmlFor="external-service-id">
					实例标识
					<Input
						id="external-service-id"
						value={id}
						disabled={busy}
						onChange={(e) => {
							setId(e.target.value);
							setEndpoint("");
							setCredential("");
							setUrl("");
						}}
					/>
				</Label>
				<Label htmlFor="external-service-endpoint">
					关联的模型端点 ID（登记后固定）
					<Input
						id="external-service-endpoint"
						value={selected?.modelEndpointId ?? endpoint}
						disabled={busy || !!selected}
						onChange={(e) => setEndpoint(e.target.value)}
					/>
				</Label>
				<Label htmlFor="external-service-url">
					服务地址
					<Input
						id="external-service-url"
						type="url"
						placeholder={selected?.url ?? "https://relay.example.com"}
						value={url}
						disabled={busy}
						onChange={(e) => {
							setUrl(e.target.value);
							setCredential("");
						}}
					/>
				</Label>
				<Label htmlFor="external-service-credential">
					该地址的服务凭据
					<Input
						id="external-service-credential"
						type="password"
						disabled={busy}
						autoComplete="new-password"
						value={credential}
						onChange={(e) => setCredential(e.target.value)}
					/>
				</Label>
				<Button
					disabled={
						!snapshot ||
						busy ||
						!id ||
						!(selected?.modelEndpointId ?? endpoint) ||
						!url ||
						!credential
					}
					onClick={() => void action("save")}
				>
					保存候选配置
				</Button>
			</section>
			{selected && (
				<section className="grid gap-2">
					<h2>版本管理</h2>
					<p>
						候选 v{selected.revision} · {selected.url} ·{" "}
						{selected.verified === selected.revision ? "验证通过" : "待验证"}
					</p>
					<p>
						{selected.active
							? `生效 v${selected.active} · ${selected.activeUrl}`
							: "已停用"}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button disabled={busy} onClick={() => void action("test")}>
							测试连接
						</Button>
						<Button
							disabled={
								busy ||
								selected.verified !== selected.revision ||
								selected.active === selected.revision
							}
							onClick={() => void action("enable")}
						>
							启用候选版本
						</Button>
						<Button
							disabled={busy || !selected.active}
							onClick={() => void action("discover")}
						>
							查询当前授权
						</Button>
						<Button
							disabled={busy || !selected.active}
							onClick={() => void action("disable")}
						>
							停用服务
						</Button>
					</div>
				</section>
			)}
			{message && (
				<Alert tone="info" role="status">
					{message}
				</Alert>
			)}
			<section>
				<h2>最近操作</h2>
				{snapshot?.history.map((item, index) => (
					<p key={index}>
						{item.time} · {item.actor} · {item.id} v{item.revision} ·{" "}
						{item.action} · {item.outcome}
					</p>
				))}
			</section>
		</div>
	);
}
