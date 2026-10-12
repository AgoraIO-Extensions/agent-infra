import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog as previousCatalog,
	bitbucketServerLegacyProviderReleaseIds as previousIds,
} from "./bitbucket-server.ts";
import { bitbucketV9ExecutorDigest } from "./bitbucket-v9-integrity.ts";

export const bitbucketV9LegacyProviderReleaseIds = [
	previousCatalog.providerReleaseId,
	...previousIds,
] as const;
export const bitbucketV9ConnectionCatalog = {
	...previousCatalog,
	providerReleaseId: previousCatalog.providerReleaseId.replace(/-v8$/, "-v9"),
	executorDigest: bitbucketV9ExecutorDigest,
	actions: previousCatalog.actions.map((action) => ({
		...action,
		id: action.id.replace(/@v8$/, "@v9"),
	})),
} as const;

/** Keep immutable v8 validation/bounds; only correct the compare enumeration transport. */
export class BitbucketV9Adapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = "bitbucket";
	readonly providerReleaseId = bitbucketV9ConnectionCatalog.providerReleaseId;
	private readonly previous: BitbucketServerAdapter;
	private readonly comparison: BitbucketServerAdapter;
	constructor(fetcher: typeof fetch) {
		this.previous = new BitbucketServerAdapter(fetcher);
		this.comparison = new BitbucketServerAdapter((input, init) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/compare/changes")) {
				// Bitbucket compare uses from=source, to=destination. Diff uses since=base, until=target.
				const base = url.searchParams.get("from");
				const target = url.searchParams.get("to");
				if (!base || !target)
					throw Object.assign(new Error("Missing comparison commits"), {
						providerError: true,
					});
				url.searchParams.set("from", target);
				url.searchParams.set("to", base);
			}
			return fetcher(url, init);
		});
	}
	async validateCredential(token: string) {
		return {
			...(await this.previous.validateCredential(token)),
			providerReleaseId: this.providerReleaseId,
		};
	}
	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		if (
			input.action === "bitbucket.get_current_user" ||
			input.action === "get_current_user"
		) {
			const identity = (await this.previous.execute(input)) as Record<
				string,
				unknown
			>;
			return { ...identity, providerReleaseId: this.providerReleaseId };
		}
		return (
			input.action === "bitbucket.compare_refs" ||
			input.action === "compare_refs"
				? this.comparison
				: this.previous
		).execute(input);
	}
}
