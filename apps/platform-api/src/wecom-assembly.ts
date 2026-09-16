import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	createWecomReceiptAccessV1,
	type WecomIdentityPortV1,
} from "@agent-infra/platform-core";
import { PostgresWecomChannelV1 } from "@agent-infra/platform-store";
import {
	createWecomAdapterV1,
	createWecomReplyEncryptorV1,
	type WecomConfigurationV1,
} from "@agent-infra/wecom";
import type { WecomRoutesDependenciesV1 } from "./http/wecom-routes.js";
export interface WecomApiDeploymentV1 {
	readonly identity: WecomIdentityPortV1;
	readonly resolveBinding: (
		reference: string,
	) => Promise<WecomConfigurationV1 | null>;
	readonly replyEncryptionPublicKeyPem: string;
	readonly observe: WecomRoutesDependenciesV1["observe"];
}
export function assembleWecomApiV1(
	databaseUrl: string,
	deployment: WecomApiDeploymentV1,
) {
	const protectReply = createWecomReplyEncryptorV1(
		deployment.replyEncryptionPublicKeyPem,
	);
	const receipts = assembleWecomReceiptApiV1(databaseUrl, deployment.identity);
	const { store, authorization } = receipts;
	return {
		dependencies: {
			resolveBinding: deployment.resolveBinding,
			adapter: createWecomAdapterV1({ protectReply }),
			channel: createWecomChannelV1({ authorization, store }),
			observe: deployment.observe,
			receipts: receipts.dependencies.receipts,
		} satisfies WecomRoutesDependenciesV1,
		store,
		close: () => store.close(),
	};
}

export function assembleWecomReceiptApiV1(
	databaseUrl: string,
	identity: WecomIdentityPortV1,
) {
	const store = new PostgresWecomChannelV1({ databaseUrl });
	const authorization = createWecomAuthorizationV1({ identity, state: store });
	return {
		store,
		authorization,
		dependencies: {
			receipts: createWecomReceiptAccessV1({ store, authorization }),
		},
		close: () => store.close(),
	};
}
