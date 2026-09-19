import { randomUUID } from "node:crypto";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	createWecomDeliveryV1,
	type TaskRuntimeAuthorizationRecordV1,
	type WecomDeliveryStatusV1,
	type WecomIdentityPortV1,
	type WecomSendPortV1,
} from "@agent-infra/platform-core";
import { PostgresWecomChannelV1 } from "@agent-infra/platform-store";
import {
	createPlatformWecomConnectionsV1,
	type WecomConnectionsDeploymentV1,
} from "./wecom-connections.js";
import {
	createWecomSetupWorkerV1,
	type WecomSetupWorkerDeploymentV1,
} from "./wecom-setup.js";

export interface WecomWorkerDeploymentV1 {
	readonly identity: WecomIdentityPortV1;
	readonly observe: (status: WecomDeliveryStatusV1) => void;
	readonly sender: WecomSendPortV1;
	readonly connections?: WecomConnectionsDeploymentV1;
	readonly setup?: WecomSetupWorkerDeploymentV1;
}

/** Channel transport and replies; Runtime execution stays with the shared conversation Worker. */
export function createPlatformWecomWorkerV1(
	options: WecomWorkerDeploymentV1 & { readonly databaseUrl: string },
) {
	if (options.setup && !options.connections)
		throw new Error("WeCom setup requires a connection deployment");
	const connectionHolderId = randomUUID();
	const store = new PostgresWecomChannelV1({
		connectionHolderId,
		databaseUrl: options.databaseUrl,
		observe: options.observe,
	});
	const authorization = createWecomAuthorizationV1({
		identity: options.identity,
		state: store,
	});
	const channel = createWecomChannelV1({ authorization, store });
	const setup =
		options.setup && options.connections
			? createWecomSetupWorkerV1({
					...options.setup,
					...options.connections,
					databaseUrl: options.databaseUrl,
				})
			: undefined;
	const deployment = options.connections;
	const connections = deployment
		? createPlatformWecomConnectionsV1({
				...options.connections,
				holderId: connectionHolderId,
				bindings: async () => {
					const bindings = [
						...(await deployment.bindings()),
						...((await setup?.bindings()) ?? []),
					];
					if (
						new Set(bindings.map((binding) => binding.botId)).size !==
						bindings.length
					)
						throw new Error("Invalid WeCom connection bindings");
					return bindings;
				},
				databaseUrl: options.databaseUrl,
				receive: channel.receive,
			})
		: undefined;
	const delivery = createWecomDeliveryV1({
		store,
		authorization,
		sender: {
			async send(input) {
				if (connections && options.connections) {
					const route = await options.connections
						.revealReply(input.replyHandle)
						.catch(() => null);
					if (!route) return "failed";
					if (route.websocket) return connections.sender.send(input);
				}
				return options.sender.send(input);
			},
		},
	});
	return {
		async reconcile() {
			if (setup) {
				try {
					await setup.tick();
				} catch {
					try {
						options.connections?.observeIngress?.("unavailable");
					} catch {
						/* Observation only. */
					}
				}
			}
			await connections?.tick();
		},
		async dispatch() {
			// Claim a bounded batch so one slow reply cannot serialize all bots.
			const results = await Promise.allSettled(
				Array.from({ length: 8 }, () => delivery.dispatch()),
			);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			return results.some(
				(result) => result.status === "fulfilled" && result.value,
			);
		},
		async channelAuthorizationCurrent(
			record: TaskRuntimeAuthorizationRecordV1,
		) {
			if (!/^wecom_(bot|app):/.test(record.boundary.channelId)) return true;
			const receipt = await store.scopeForExecution(
				record.executionId,
				record.boundary.principal.id,
				record.boundary.channelId,
			);
			if (!receipt) return false;
			const current = await authorization.authorize(receipt.scope, "read");
			return (
				current.outcome === "allowed" &&
				current.authority.actor.actorId === record.boundary.principal.id &&
				current.authority.channelRevision === receipt.channelRevision
			);
		},
		async close() {
			const results = await Promise.allSettled([
				setup?.close(),
				connections?.close(),
				store.close(),
			]);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
}
