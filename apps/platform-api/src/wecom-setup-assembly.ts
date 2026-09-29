import { createWecomSetupV1 } from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresWecomSetupV1,
} from "@agent-infra/platform-store";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import {
	type IdentityAdapter,
	resolveCurrentTaskUser,
} from "./http/identity.js";
export function assembleWecomSetupApiV1(options: {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
	readonly encryptionKeys: unknown;
}) {
	const store = new PostgresWecomSetupV1(options);
	const query = new PostgresAgentConfigurationQueryV1(options);
	const encryptor = createSecretEncryptorV1({
		encryptionKeys: options.encryptionKeys,
	});
	const setup = createWecomSetupV1({
		store,
		async authority(agentId, actorId) {
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
		},
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
		async close() {
			await store.close();
			await query.close();
		},
	};
}
