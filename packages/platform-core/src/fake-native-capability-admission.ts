import type { ConversationExecutionAuthorityV1 } from "./conversation-execution-types.js";
import {
	type NativeCapabilityAdmissionCapabilityV1,
	type NativeCapabilityAdmissionRequestV1,
	type NativeCapabilityMetadataProjectionV1,
	type NativeCapabilityMetadataRevalidationPortV1,
	parseNativeCapabilityMetadataProjectionV1,
} from "./native-capability-admission.js";

/** Test-only metadata source; production must inject an authenticated reader. */
export class FakeNativeCapabilityMetadataRevalidationV1
	implements NativeCapabilityMetadataRevalidationPortV1
{
	#projection: NativeCapabilityMetadataProjectionV1;
	#available: boolean;

	constructor(input: {
		readonly projection: NativeCapabilityMetadataProjectionV1;
		readonly available?: boolean;
	}) {
		this.#projection = parseNativeCapabilityMetadataProjectionV1(
			input.projection,
		);
		this.#available = input.available ?? true;
	}

	setProjection(projection: NativeCapabilityMetadataProjectionV1): void {
		this.#projection = parseNativeCapabilityMetadataProjectionV1(projection);
	}

	setAvailable(available: boolean): void {
		this.#available = available;
	}

	async revalidate(input: {
		readonly request: NativeCapabilityAdmissionRequestV1;
		readonly authority: ConversationExecutionAuthorityV1;
		readonly sessionGeneration: number;
	}) {
		if (!this.#available) return { outcome: "unavailable" as const };
		const projection = parseNativeCapabilityMetadataProjectionV1(
			this.#projection,
		);
		if (projection.revision !== input.request.directoryRevision)
			return { outcome: "stale" as const };
		const selected = projection.capabilities.find(
			({ id }) => id === input.request.capabilityId,
		);
		if (!selected) return { outcome: "unknown" as const };
		if (
			(selected.kind === "command" && selected.availability !== "available") ||
			(selected.kind === "skill" && selected.availability !== "discovered")
		)
			return { outcome: "disabled" as const };
		return {
			outcome: "allowed" as const,
			scope: Object.freeze({
				agentId: input.authority.agentId,
				actorId: input.authority.actorId,
				channelId: input.authority.channelId,
				conversationId: input.request.conversationId,
				sessionGeneration: input.sessionGeneration,
				authorizationRevision: input.authority.authorizationRevision,
			}),
			capability: Object.freeze({
				...selected,
				directoryRevision: projection.revision,
			}) as NativeCapabilityAdmissionCapabilityV1,
		};
	}
}
