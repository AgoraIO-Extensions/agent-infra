import {
	createWecomAuthorizationV1,
	createWecomDeliveryV1,
	type TaskRuntimeAuthorizationRecordV1,
	type WecomDeliveryStatusV1,
	type WecomIdentityPortV1,
	type WecomSendPortV1,
} from "@agent-infra/platform-core";
import { PostgresWecomChannelV1 } from "@agent-infra/platform-store";

export interface WecomWorkerDeploymentV1 {
	readonly identity: WecomIdentityPortV1;
	readonly observe: (status: WecomDeliveryStatusV1) => void;
	readonly sender: WecomSendPortV1;
}

/** Reply delivery only; Runtime execution is owned by the shared conversation Worker. */
export function createPlatformWecomWorkerV1(
	options: WecomWorkerDeploymentV1 & { readonly databaseUrl: string },
) {
	const store = new PostgresWecomChannelV1({
		databaseUrl: options.databaseUrl,
		observe: options.observe,
	});
	const authorization = createWecomAuthorizationV1({
		identity: options.identity,
		state: store,
	});
	const delivery = createWecomDeliveryV1({
		store,
		authorization,
		sender: options.sender,
	});
	return {
		dispatch: delivery.dispatch,
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
		close: () => store.close(),
	};
}
