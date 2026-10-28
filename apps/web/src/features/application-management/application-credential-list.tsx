import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadingLine } from "@/components/ui/spinner";
import { Timestamp } from "@/components/ui/timestamp";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { personalApiCredentialScopeLabels } from "../api-credentials/api-credentials.js";
import {
	loadApplicationCredentials,
	revokeApplicationCredential,
} from "./application-management.js";

export function ApplicationCredentialList({
	applicationId,
	client,
}: {
	applicationId: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const scope = useMemo(
		() => ({
			key: [
				"application-credential-metadata",
				applicationId,
				crypto.randomUUID(),
			] as const,
			active: false,
		}),
		[applicationId],
	);
	const [cursor, setCursor] = useState<string>();
	const [pending, setPending] = useState<string>();
	const inFlight = useRef(false);
	const [error, setError] = useState<string>();
	const [uncertain, setUncertain] = useState(false);
	const heading = useRef<HTMLHeadingElement>(null);
	const query = useQuery({
		queryKey: [...scope.key, cursor],
		queryFn: ({ signal }) =>
			loadApplicationCredentials(applicationId, cursor, client, signal),
		retry: false,
		refetchOnWindowFocus: false,
	});
	useLayoutEffect(() => {
		scope.active = true;
		return () => {
			scope.active = false;
			void queryClient.cancelQueries({ queryKey: scope.key });
			queryClient.removeQueries({ queryKey: scope.key });
		};
	}, [queryClient, scope]);
	async function reload() {
		const result = await query.refetch();
		if (scope.active && !result.error) {
			setUncertain(false);
			setError(undefined);
		}
	}
	async function revoke(credentialId: string) {
		if (inFlight.current || uncertain) return;
		inFlight.current = true;
		setPending(credentialId);
		setError(undefined);
		try {
			await revokeApplicationCredential(
				applicationId,
				credentialId,
				crypto.randomUUID(),
				client,
			);
			if (!scope.active) return;
			const result = await query.refetch();
			if (result.error) {
				setUncertain(true);
				setError("撤销已受理，但无法读取最新状态。请重新加载核实。");
			}
			heading.current?.focus();
		} catch {
			if (scope.active) {
				setUncertain(true);
				setError(
					"无法确认撤销结果，请重新加载元数据核实后再操作。页面不会自动重试撤销。",
				);
			}
		} finally {
			inFlight.current = false;
			if (scope.active) setPending(undefined);
		}
	}
	return (
		<section
			className="space-y-4 border-border border-t pt-5"
			aria-label="应用凭证列表"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 ref={heading} tabIndex={-1} className="application-section-title">
					已签发的应用凭证
				</h3>
				<Button
					type="button"
					variant="outline"
					disabled={query.isFetching || Boolean(pending)}
					onClick={() => void reload()}
				>
					重新加载凭证
				</Button>
			</div>
			{error || query.error ? (
				<Alert tone="danger" role="alert">
					<AlertDescription>
						{error ?? "无法读取应用凭证，请重新加载确认状态。"}
					</AlertDescription>
				</Alert>
			) : null}
			{query.isPending ? <LoadingLine>正在读取应用凭证…</LoadingLine> : null}
			{!query.error && query.data ? (
				<>
					{query.data.items.length === 0 ? (
						<p className="text-muted-foreground text-sm">暂无应用凭证。</p>
					) : null}
					{query.data.items.map((item) => (
						<article
							key={item.credentialId}
							className="space-y-3 rounded-lg border p-4"
						>
							<div className="flex flex-wrap items-center gap-3">
								<code className="break-all">{item.credentialId}</code>
								<Badge tone={item.revokedAt ? "red" : "gray"}>
									{item.revokedAt
										? "已撤销"
										: item.expiresAt && Date.parse(item.expiresAt) <= Date.now()
											? "已过期"
											: "有效"}
								</Badge>
							</div>
							<dl className="grid gap-3 text-sm sm:grid-cols-2">
								<div>
									<dt>权限范围</dt>
									<dd>
										{item.scopes
											.map((value) => personalApiCredentialScopeLabels[value])
											.join("、")}
									</dd>
								</div>
								<div>
									<dt>过期时间</dt>
									<dd>
										{item.expiresAt ? (
											<Timestamp value={item.expiresAt} />
										) : (
											"无到期时间"
										)}
									</dd>
								</div>
								{item.revokedAt ? (
									<div>
										<dt>撤销时间</dt>
										<dd>
											<Timestamp value={item.revokedAt} />
										</dd>
									</div>
								) : null}
							</dl>
							{!item.revokedAt ? (
								<ConfirmDialog
									disabled={Boolean(pending) || uncertain || query.isFetching}
									trigger={
										<Button
											type="button"
											variant="outline"
											aria-label={`撤销应用凭证 ${item.credentialId}`}
										>
											{pending === item.credentialId
												? "正在撤销…"
												: "撤销应用凭证"}
										</Button>
									}
									title="撤销这个应用凭证？"
									subject={{ name: item.credentialId }}
									description="该凭证将不能再访问 API。其他凭证和已受理的任务不受影响。"
									confirmLabel="撤销凭证"
									onConfirm={() => void revoke(item.credentialId)}
								/>
							) : null}
						</article>
					))}
					<div className="flex gap-3">
						{cursor ? (
							<Button
								variant="outline"
								disabled={Boolean(pending) || query.isFetching}
								onClick={() => setCursor(undefined)}
							>
								返回首页
							</Button>
						) : null}
						{query.data.nextCursor ? (
							<Button
								variant="outline"
								disabled={Boolean(pending) || query.isFetching}
								onClick={() => setCursor(query.data.nextCursor ?? undefined)}
							>
								下一页凭证
							</Button>
						) : null}
					</div>
				</>
			) : null}
		</section>
	);
}
