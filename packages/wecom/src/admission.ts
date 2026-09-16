import { createHash } from "node:crypto";
import type { AgentConfigurationChannelAdmissionPortV1 } from "@agent-infra/platform-core";
import type { WecomConfigurationV1 } from "./index.js";
/** Resolver only returns configurations allocated by deployment to this Agent. */
export function createWecomChannelAdmissionV1(
	resolve: (reference: string) => Promise<WecomConfigurationV1 | null>,
): AgentConfigurationChannelAdmissionPortV1 {
	return {
		async admitChannels(input) {
			const channels = new Map(
				input.current.map((channel) => [channel.kind, channel]),
			);
			const versions: string[] = [];
			for (const change of input.requested) {
				if (!change.enabled) {
					channels.delete(change.kind);
					continue;
				}
				const config = await resolve(change.bindingReference);
				if (
					!config ||
					config.agentId !== input.agentId ||
					config.kind !== change.kind ||
					config.bindingReference !== change.bindingReference ||
					!config.credentialVersion ||
					!config.token ||
					!/^[A-Za-z0-9+/]{43}$/.test(config.encodingAesKey) ||
					(config.kind === "wecom_bot"
						? !config.botId
						: !config.corporationId ||
							!/^\d+$/.test(config.applicationId ?? ""))
				)
					return {
						schemaVersion: 1,
						status: "rejected",
						agentId: input.agentId,
						requestId: input.requestId,
					};
				channels.set(change.kind, {
					kind: change.kind,
					bindingReference: change.bindingReference,
				});
				versions.push(config.credentialVersion);
			}
			const result = [...channels.values()].sort((a, b) =>
				a.kind.localeCompare(b.kind),
			);
			return {
				schemaVersion: 1,
				status: "admitted",
				agentId: input.agentId,
				requestId: input.requestId,
				channels: result,
				channelRevision: createHash("sha256")
					.update(JSON.stringify([result, versions]))
					.digest("hex"),
			};
		},
	};
}
