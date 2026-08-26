import type { IssuedToken } from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";

import { connectionApi } from "../api";
import { ConsoleShell, PageError } from "../shell";
import { PageHeader, TokensView } from "../views";

export function TokensPage() {
	const queryClient = useQueryClient();
	const [issued, setIssued] = useState<IssuedToken | null>(null);
	const tokens = useQuery({
		queryKey: ["tokens"],
		queryFn: connectionApi.listTokens,
	});
	const issue = useMutation({
		mutationFn: connectionApi.issueToken,
		onSuccess: async ({ issued: nextIssued }) => {
			setIssued(nextIssued);
			await queryClient.invalidateQueries({ queryKey: ["tokens"] });
		},
	});
	const revoke = useMutation({
		mutationFn: connectionApi.revokeToken,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tokens"] }),
	});
	const onIssue = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = event.currentTarget;
		const name = String(new FormData(form).get("name") ?? "");
		issue.mutate(name, { onSuccess: () => form.reset() });
	};

	return (
		<ConsoleShell>
			<PageHeader title="访问令牌" />
			{tokens.isError ? <PageError error={tokens.error} /> : null}
			{issue.isError ? <PageError error={issue.error} /> : null}
			{revoke.isError ? <PageError error={revoke.error} /> : null}
			{tokens.isPending ? (
				<div className="skeleton-block" role="status" aria-label="正在加载" />
			) : tokens.isError ? null : (
				<TokensView
					busy={issue.isPending}
					issued={issued}
					onCopy={
						issued
							? () => navigator.clipboard.writeText(issued.token)
							: undefined
					}
					onIssue={onIssue}
					onRevoke={(tokenId) => {
						if (window.confirm("确认撤销这个访问令牌？"))
							revoke.mutate(tokenId);
					}}
					tokens={tokens.data?.tokens ?? []}
				/>
			)}
		</ConsoleShell>
	);
}
