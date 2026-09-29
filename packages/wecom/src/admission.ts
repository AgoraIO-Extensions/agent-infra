import { createHash } from "node:crypto";
import type { AgentConfigurationChannelAdmissionPortV1 } from "@agent-infra/platform-core";
import type { WecomConfigurationV1 } from "./index.js";

export interface WecomManagedBotAdmissionV1 {
	readonly agentId: string;
	readonly kind: "wecom_bot";
	readonly bindingReference: string;
	readonly credentialVersion: string;
}

/** Resolver only returns configurations allocated by deployment to this Agent. */
function validConfiguration(
	config: WecomConfigurationV1 | null,
	agentId: string,
	kind: "wecom_bot" | "wecom_app",
	bindingReference: string,
): config is WecomConfigurationV1 {
	return (
		config !== null &&
		config.agentId === agentId &&
		config.kind === kind &&
		config.bindingReference === bindingReference &&
		!!config.credentialVersion &&
		!!config.token &&
		/^[A-Za-z0-9+/]{43}$/.test(config.encodingAesKey) &&
		(kind === "wecom_bot"
			? !!config.botId
			: !!config.corporationId &&
				/^[1-9][0-9]{0,14}$/.test(config.applicationId ?? ""))
	);
}

export function createWecomChannelAdmissionV1(
	resolve: (reference: string) => Promise<WecomConfigurationV1 | null>,
	resolveManagedBot?: (
		reference: string,
	) => Promise<WecomManagedBotAdmissionV1 | null>,
): AgentConfigurationChannelAdmissionPortV1 {
	return {
		async admitChannels(input) {
			const resolved = new Map<string, WecomConfigurationV1 | null>();
			const managed = new Map<string, WecomManagedBotAdmissionV1 | null>();
			const load = async (reference: string) => {
				if (!resolved.has(reference))
					resolved.set(reference, await resolve(reference));
				return resolved.get(reference) ?? null;
			};
			const version = async (channel: {
				kind: "wecom_bot" | "wecom_app";
				bindingReference: string;
			}) => {
				const config = await load(channel.bindingReference);
				if (config !== null)
					return validConfiguration(
						config,
						input.agentId,
						channel.kind,
						channel.bindingReference,
					)
						? config.credentialVersion
						: null;
				if (channel.kind !== "wecom_bot" || !resolveManagedBot) return null;
				if (!managed.has(channel.bindingReference))
					managed.set(
						channel.bindingReference,
						await resolveManagedBot(channel.bindingReference),
					);
				const proof = managed.get(channel.bindingReference);
				return proof?.kind === "wecom_bot" &&
					proof.agentId === input.agentId &&
					proof.bindingReference === channel.bindingReference &&
					proof.credentialVersion
					? proof.credentialVersion
					: null;
			};
			const channels = new Map(
				input.current.map((channel) => [channel.kind, channel]),
			);
			for (const change of input.requested) {
				if (!change.enabled) {
					channels.delete(change.kind);
					continue;
				}
				if (!(await version(change)))
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
			}
			const result = [...channels.values()].sort((a, b) =>
				a.kind.localeCompare(b.kind),
			);
			const versions: [string, string, string][] = [];
			for (const channel of result) {
				const credentialVersion = await version(channel);
				if (!credentialVersion) {
					return {
						schemaVersion: 1,
						status: "rejected",
						agentId: input.agentId,
						requestId: input.requestId,
					};
				}
				versions.push([
					channel.kind,
					channel.bindingReference,
					credentialVersion,
				]);
			}
			return {
				schemaVersion: 1,
				status: "admitted",
				agentId: input.agentId,
				requestId: input.requestId,
				channels: result,
				channelRevision: createHash("sha256")
					.update(JSON.stringify(versions))
					.digest("hex"),
			};
		},
	};
}
