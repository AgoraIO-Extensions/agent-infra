import { createHash, randomUUID } from "node:crypto";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	RuntimeHostSourceReadRequestV1Schema,
	type RuntimeHostSourceReadResponseV1,
	RuntimeHostSourceReadResponseV1Schema,
} from "@agent-infra/contracts/runtime";

const podUidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function reference(prefix: string, ...parts: string[]) {
	return `${prefix}${createHash("sha256")
		.update(parts.join("\n"))
		.digest("base64url")
		.slice(0, 43)}`;
}

/**
 * #4358 I3b1 (Engineering Spec §18.5.1): this Host's opaque instance and start references.
 * The instance reference is fixed for the Pod UID; the start reference changes with every
 * Host process start. Neither is a capability or carries the Pod UID in clear.
 */
export function runtimeHostSourceIdentityV1(
	podUid: string,
	startId: string = randomUUID(),
) {
	return {
		instanceRef: reference(
			"hi1-",
			"agent-infra/runtime-host/instance/v1",
			podUid,
		),
		startRef: reference(
			"hs1-",
			"agent-infra/runtime-host/start/v1",
			podUid,
			startId,
		),
	};
}

function mismatch(): never {
	throw new RuntimeHostError(
		"RUNTIME_HOST_SOURCE_MISMATCH",
		"Runtime Host source does not match this request",
		409,
	);
}

/**
 * The protected Host route the Worker confirms the Host source on. The Host answers only for
 * its own Pod UID and for a committed Host Session of the same Agent, Conversation and Session
 * generation; anything else is a fixed mismatch. It reads committed state only.
 */
export function createRuntimeHostSourceReadV1(options: {
	readonly podUid: string;
	readonly identity: {
		readonly instanceRef: string;
		readonly startRef: string;
	};
	readonly readHostSessionBinding: (hostSessionRef: string) => Promise<
		| {
				readonly agentId: string;
				readonly conversationId: string;
				readonly sessionGeneration: number;
		  }
		| undefined
	>;
}) {
	if (!podUidPattern.test(options.podUid))
		throw new TypeError("Runtime Host source Pod UID is invalid");
	return {
		async read(value: unknown): Promise<RuntimeHostSourceReadResponseV1> {
			const parsed = RuntimeHostSourceReadRequestV1Schema.safeParse(value);
			if (!parsed.success)
				throw new RuntimeHostError(
					"RUNTIME_REQUEST_INVALID",
					"Runtime request is invalid",
					400,
				);
			const request = parsed.data;
			if (request.podUid !== options.podUid) mismatch();
			const session = await options.readHostSessionBinding(
				request.hostSessionRef,
			);
			if (
				!session ||
				session.agentId !== request.agentId ||
				session.conversationId !== request.conversationId ||
				session.sessionGeneration !== request.sessionGeneration
			)
				mismatch();
			return RuntimeHostSourceReadResponseV1Schema.parse({
				schemaVersion: 1,
				podUid: options.podUid,
				agentId: session.agentId,
				conversationId: session.conversationId,
				hostSessionRef: request.hostSessionRef,
				sessionGeneration: session.sessionGeneration,
				host: {
					instanceRef: options.identity.instanceRef,
					startRef: options.identity.startRef,
				},
			});
		},
	};
}

export type RuntimeHostSourceReadV1 = ReturnType<
	typeof createRuntimeHostSourceReadV1
>;
