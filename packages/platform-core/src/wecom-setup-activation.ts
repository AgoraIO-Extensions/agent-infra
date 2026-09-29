import { createHash } from "node:crypto";
import {
	type AgentConfigurationTransactionPortV1,
	createAgentConfigurationUseCaseV1,
} from "./agent-configuration.js";
import type {
	WecomSetupAuthorityV1,
	WecomSetupRecordV1,
} from "./wecom-setup.js";

/** Owns the admission and channel replacement policy after a successful bot probe. */
export function createWecomSetupActivationV1(options: {
	readonly transaction: AgentConfigurationTransactionPortV1;
	readonly readCurrentUser: (actorId: string) => Promise<{
		readonly accountStatus: string;
		readonly organizationIds: readonly string[];
	} | null>;
	readonly readAuthority: (
		session: WecomSetupRecordV1,
		organizationIds: readonly string[],
	) => Promise<WecomSetupAuthorityV1 | null>;
}) {
	async function authority(session: WecomSetupRecordV1) {
		const user = await options.readCurrentUser(session.actorId);
		if (user?.accountStatus !== "active") return null;
		const current = await options.readAuthority(session, user.organizationIds);
		return current?.configuration.agentId === session.agentId &&
			current.configuration.revision === session.configurationRevision &&
			current.authorizationRevision === session.authorizationRevision
			? current
			: null;
	}
	return {
		authority,
		async activate(session: WecomSetupRecordV1) {
			const unavailable = async (): Promise<never> => {
				throw new Error("Unexpected WeCom configuration admission");
			};
			const configuration = createAgentConfigurationUseCaseV1({
				transaction: options.transaction,
				authorizationAdmission: {
					async authorize(request) {
						const current = await authority(session);
						return current
							? {
									schemaVersion: 1,
									status: "admitted",
									agentId: session.agentId,
									actorId: session.actorId,
									authorizationRevision: current.authorizationRevision,
								}
							: {
									schemaVersion: 1,
									status: "rejected",
									agentId: request.agentId,
									actorId: request.actorId,
								};
					},
				},
				channelAdmission: {
					async admitChannels(input) {
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: session.agentId,
							requestId: input.requestId,
							channelRevision: session.sessionId,
							channels: [
								...input.current.filter(
									(channel) => channel.kind !== "wecom_bot",
								),
								{ kind: "wecom_bot", bindingReference: session.sessionId },
							],
						};
					},
				},
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
			});
			return configuration.update(
				{
					schemaVersion: 2,
					agentId: session.agentId,
					idempotencyKey: session.sessionId,
					requestId: session.sessionId,
					traceId: session.sessionId,
					changes: {
						channels: [
							{
								kind: "wecom_bot",
								enabled: true,
								bindingReference: session.sessionId,
							},
						],
					},
				},
				{
					schemaVersion: 1,
					actorId: session.actorId,
					rawRequestDigest: createHash("sha256")
						.update(session.sessionId)
						.digest("hex"),
				},
			);
		},
	};
}
