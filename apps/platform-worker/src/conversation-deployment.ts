import { createPublicKey } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import {
	createWorkloadRuntimeV1,
	isWorkloadExecutionCapacityCurrentV1,
	type WorkloadRuntimeOptionsV1,
} from "./workload-runtime.js";
import { validateWorkloadRuntimeAuthV1 } from "./workload-runtime-auth.js";

/** Resolve only a currently observed Workload through the existing deployment adapter. */
export function createProductionConversationRuntimeResolverV2(options: {
	readonly workload: WorkloadRuntimeOptionsV1;
	readonly signing: ConversationRuntimeOptionsV2["signing"];
	readonly serviceToken: string;
}): ConversationRuntimeOptionsV2["resolveRuntimeHost"] {
	const { workload, signing, serviceToken } = options;
	const auth = workload.policy.runtimeAuth;
	try {
		if (!auth) throw new Error();
		validateWorkloadRuntimeAuthV1(auth);
		if (
			auth.workerId !== signing.workerId ||
			auth.grantIssuer !== signing.issuer ||
			auth.grantKeyId !== signing.keyId ||
			createPublicKey(signing.privateKey)
				.export({ type: "spki", format: "pem" })
				.toString()
				.trim() !== auth.grantPublicKey.trim() ||
			typeof serviceToken !== "string" ||
			!/^[\x21-\x7e]{1,8192}$/.test(serviceToken)
		)
			throw new Error();
	} catch {
		throw new TypeError(
			"Conversation Runtime deployment authorization is invalid",
		);
	}
	const runtime = createWorkloadRuntimeV1(workload);
	return async (input) => {
		try {
			input.signal.throwIfAborted();
			const state = input.workload;
			if (
				!state ||
				state.agentId !== input.agentId ||
				!state.identity ||
				(input.purpose === "business" && state.phase !== "ready")
			)
				throw new Error();
			const deployment = validateAgentWorkloadDesiredV1(
				input.purpose === "control"
					? state.verified?.deployment
					: state.candidate.deployment,
			);
			if (
				deployment.agentId !== input.agentId ||
				deployment.runtimeManifest.interactionMode !== "platform-adapter"
			)
				throw new Error();
			// observe checks actual ownership, UID/generation, Pod/spec/Secret/network
			// drift, health and signed Runtime readiness; it never changes resources.
			const health = await (input.purpose === "control"
				? runtime.observeVerifiedControl(state)
				: runtime.observe(state));
			if (health !== "healthy") throw new Error();
			if (
				input.purpose === "business" &&
				input.command === "turn.submit" &&
				!isWorkloadExecutionCapacityCurrentV1(workload, state)
			)
				throw new Error();
			input.signal.throwIfAborted();
			const service = `${workloadResourceNameV1(input.agentId)}${input.purpose === "control" ? "-probe" : ""}`;
			return {
				baseUrl: `http://${service}.${workload.policy.namespace}.svc:${deployment.service.port}`,
				serviceToken,
				workerId: signing.workerId,
			};
		} catch {
			throw new ConversationRuntimeHostError(
				"RUNTIME_WORKLOAD_UNAVAILABLE",
				true,
			);
		}
	};
}
