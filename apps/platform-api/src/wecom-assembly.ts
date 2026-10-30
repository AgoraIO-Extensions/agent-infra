import type { SessionSandboxReserveConfigurationV1 } from "@agent-infra/platform-core";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	createWecomReceiptAccessV1,
	createWecomSupplementaryInstructionReaderV1,
	type TaskUserDirectoryV1,
	type WecomConnectionAuthorizationPortV1,
	type WecomIdentityPortV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresWecomChannelV1,
} from "@agent-infra/platform-store";
import {
	createWecomAdapterV1,
	createWecomReplyEncryptorV1,
	type WecomConfigurationV1,
} from "@agent-infra/wecom";
import type { WecomRoutesDependenciesV1 } from "./http/wecom-routes.js";
export interface WecomApiDeploymentV1 {
	readonly sessionSandboxReserves?: SessionSandboxReserveConfigurationV1;
	readonly identity: WecomIdentityPortV1;
	readonly connectionAuthorization?: WecomConnectionAuthorizationPortV1;
	readonly userDirectory?: TaskUserDirectoryV1;
	readonly verifyCallback?: (reference: string) => Promise<boolean>;
	readonly acceptMessages?: (reference: string) => Promise<boolean>;
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
	if (typeof deployment.userDirectory?.resolveUser !== "function")
		throw new Error(
			"WeCom message admission requires a trusted user directory",
		);
	const protectReply = createWecomReplyEncryptorV1(
		deployment.replyEncryptionPublicKeyPem,
	);
	const receipts = assembleWecomReceiptApiV1(
		databaseUrl,
		deployment.identity,
		deployment.userDirectory,
		deployment.connectionAuthorization,
		deployment.sessionSandboxReserves,
	);
	const { store, authorization } = receipts;
	// #3375：与 Web 读取同一 Runtime 展示投影中的补充指令能力。
	const runtimePresentation = new PostgresAgentConfigurationQueryV1({
		databaseUrl,
	});
	return {
		dependencies: {
			resolveBinding: deployment.resolveBinding,
			...(deployment.verifyCallback
				? { verifyCallback: deployment.verifyCallback }
				: {}),
			...(deployment.acceptMessages
				? { acceptMessages: deployment.acceptMessages }
				: {}),
			adapter: createWecomAdapterV1({ protectReply }),
			channel: createWecomChannelV1({
				authorization,
				store,
				supplementaryInstruction: createWecomSupplementaryInstructionReaderV1({
					runtime: runtimePresentation,
					identity: deployment.identity,
					state: store,
				}),
			}),
			observe: deployment.observe,
			receipts: receipts.dependencies.receipts,
		} satisfies WecomRoutesDependenciesV1,
		store,
		close: async () => {
			try {
				await store.close();
			} finally {
				await runtimePresentation.close();
			}
		},
	};
}

export function assembleWecomReceiptApiV1(
	databaseUrl: string,
	identity: WecomIdentityPortV1,
	userDirectory?: TaskUserDirectoryV1,
	connectionAuthorization?: WecomConnectionAuthorizationPortV1,
	sessionSandboxReserves?: SessionSandboxReserveConfigurationV1,
) {
	const store = new PostgresWecomChannelV1({
		sessionSandboxReserves,
		databaseUrl,
		userDirectory,
		identity,
		connectionAuthorization,
	});
	const authorization = createWecomAuthorizationV1({
		identity,
		state: store,
		connectionAuthorization,
	});
	return {
		store,
		authorization,
		dependencies: {
			receipts: createWecomReceiptAccessV1({ store, authorization }),
		},
		close: () => store.close(),
	};
}
