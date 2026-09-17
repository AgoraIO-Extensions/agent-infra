import { createWecomSetupV1 } from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresWecomSetupV1,
} from "@agent-infra/platform-store";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import {
	createWecomCallbackCipherV1,
	type WecomCallbackKeysV1,
	type WecomConfigurationV1,
} from "@agent-infra/wecom";
import {
	type IdentityAdapter,
	resolveCurrentTaskUser,
} from "./http/identity.js";
export function assembleWecomSetupApiV1(options: {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
	readonly encryptionKeys: unknown;
	readonly application?: {
		readonly publicOrigin: string;
		readonly callbackKeys: WecomCallbackKeysV1;
	};
}) {
	const callbackCipher = options.application
		? createWecomCallbackCipherV1(options.application.callbackKeys)
		: undefined;
	const callbackOrigin = options.application
		? new URL(options.application.publicOrigin)
		: undefined;
	if (
		callbackOrigin &&
		(callbackOrigin.protocol !== "https:" ||
			callbackOrigin.username ||
			callbackOrigin.password ||
			callbackOrigin.pathname !== "/" ||
			callbackOrigin.search ||
			callbackOrigin.hash)
	)
		throw new Error("Invalid WeCom callback origin");
	const store = new PostgresWecomSetupV1(options);
	const query = new PostgresAgentConfigurationQueryV1(options);
	const encryptor = createSecretEncryptorV1({
		encryptionKeys: options.encryptionKeys,
	});
	async function authority(agentId: string, actorId: string) {
		const user = await resolveCurrentTaskUser(
			options.identity,
			actorId,
			"wecom-setup",
		);
		if (user?.accountStatus !== "active") return null;
		const current = await query.readAuthority({
			agentId,
			actorId,
			organizationIds: user.organizationIds,
			isAdministrator: false,
		});
		return current.outcome === "found" ? current : null;
	}
	const setup = createWecomSetupV1({
		...(callbackCipher
			? ({
					async encryptApplication(session, credential) {
						if (
							(await store.callbackKeyIds()).some(
								(id) => !callbackCipher.hasKey(id),
							)
						)
							throw new Error("WeCom callback key still referenced");
						const encryptedCredential = await encryptor.encrypt({
							schemaVersion: 1,
							secretId: session.sessionId,
							ownerType: "agent-owner",
							ownerId: session.actorId,
							agentId: session.agentId,
							name: "wecom_app",
							secretVersion: 1,
							configRevision: session.configurationRevision,
							plaintext: JSON.stringify({
								corporationId: credential.corporationId,
								applicationId: credential.applicationId,
								secret: credential.secret,
							}),
							occurredAt: new Date().toISOString(),
						});
						return {
							encryptedCredential,
							encryptedCallback: callbackCipher.encrypt(session, {
								token: credential.token,
								encodingAesKey: credential.encodingAesKey,
							}),
						};
					},
				} satisfies Pick<
					Parameters<typeof createWecomSetupV1>[0],
					"encryptApplication"
				>)
			: {}),
		store,
		authority,
		async encrypt(session, credential) {
			return encryptor.encrypt({
				schemaVersion: 1,
				secretId: session.sessionId,
				ownerType: "agent-owner",
				ownerId: session.actorId,
				agentId: session.agentId,
				name: "wecom_bot",
				secretVersion: 1,
				configRevision: session.configurationRevision,
				plaintext: JSON.stringify(credential),
				occurredAt: new Date().toISOString(),
			});
		},
	});
	return {
		setup,
		isActive: async (reference: string) =>
			(await store.bindings("wecom_app")).some(
				(s) => s.sessionId === reference,
			),
		callbackUrl: (sessionId: string) =>
			callbackOrigin
				? new URL(
						`/callbacks/wecom/${encodeURIComponent(sessionId)}`,
						callbackOrigin,
					).href
				: undefined,
		async resolveApplication(
			reference: string,
		): Promise<WecomConfigurationV1 | null> {
			if (!callbackCipher) return null;
			const session = await setup.callback(reference);
			if (!session?.application) return null;
			return {
				kind: "wecom_app",
				agentId: session.agentId,
				bindingReference: session.sessionId,
				credentialVersion: session.sessionId,
				...session.application,
				...callbackCipher.decrypt(session),
			};
		},
		async ownsReference(reference: string) {
			return !!(await store.read(reference));
		},
		async verifyCallback(reference: string) {
			const session = await store.read(reference);
			if (session?.kind !== "wecom_app") return true;
			if (session.status === "active")
				return (await store.bindings("wecom_app")).some(
					(s) => s.sessionId === reference,
				);
			return store.verifyCallback(reference);
		},
		async close() {
			await store.close();
			await query.close();
		},
	};
}
