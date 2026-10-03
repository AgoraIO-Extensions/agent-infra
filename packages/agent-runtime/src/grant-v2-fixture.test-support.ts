import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	type RuntimeExecutionGrantClaimsV2,
	RuntimeExecutionGrantClaimsV2Schema,
	type RuntimeSubmitTurnRequestV3,
	runtimeRequestSigningPayloadV3,
} from "@agent-infra/contracts/runtime";
import { createRuntimeExecutionGrantVerifierV2 } from "./grant-v2.js";

export const runtimeV2Keys = generateKeyPairSync("ed25519");
export const verifyRuntimeV2Fixture = createRuntimeExecutionGrantVerifierV2(
	new Map([["fixture", runtimeV2Keys.publicKey]]),
);
export const fixtureNow = 1_800_000_000_000;
export function submitV3Fixture(): Omit<RuntimeSubmitTurnRequestV3, "grant"> {
	return {
		schemaVersion: 3,
		requestId: "request-fixture",
		traceId: "trace-fixture",
		principal: { kind: "user", id: "user-fixture" },
		channelId: "web",
		agentId: "agent-fixture",
		conversationId: "conversation-fixture",
		executionId: "execution-fixture",
		turnId: "turn-fixture",
		sessionGeneration: 1,
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "execution-fixture",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		input: { text: "synthetic input", attachments: [] },
	};
}
export function signV3Fixture<
	T extends Omit<RuntimeSubmitTurnRequestV3, "grant" | "input">,
>(
	request: T,
	command: RuntimeExecutionGrantClaimsV2["allowedCommands"][0],
	options: {
		now?: number;
		purpose?: "business" | "control";
		reason?:
			| "stop"
			| "authorization_revoked"
			| "recovery"
			| "generation_isolation";
		claims?: Record<string, unknown>;
	} = {},
) {
	const supplied = request as T & {
		input?: { attachments: string[] };
		afterCursor?: string | null;
		confirmedCursor?: string;
	};
	const now = options.now ?? fixtureNow;
	const claims = RuntimeExecutionGrantClaimsV2Schema.parse({
		schemaVersion: 2,
		issuer: "platform-fixture",
		audience: "runtime_host",
		workerId: "worker-fixture",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-fixture",
		principal: request.principal,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		allowedCommands: [command],
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV3({ ...request, grant: undefined }))
			.digest("hex"),
		...(options.purpose === "control"
			? {
					purpose: "control",
					controlRecordId: "control-fixture",
					reason: options.reason ?? "authorization_revoked",
				}
			: {
					purpose: "business",
					authorizationRecordId: "authorization-fixture",
					attachments: (supplied.input?.attachments ?? []).map(
						(attachmentId) => ({ attachmentId, operations: ["read"] }),
					),
				}),
		...(command === "events.persist"
			? {
					eventAccess: {
						command,
						consumer: "platform_worker_persistence",
						afterCursor: supplied.afterCursor ?? null,
					},
				}
			: command === "events.ack"
				? {
						eventAccess: {
							command,
							consumer: "platform_worker_persistence",
							confirmedCursor: supplied.confirmedCursor,
						},
					}
				: {}),
		...options.claims,
	});
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "fixture",
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = sign(
		null,
		Buffer.from(`${header}.${payload}`),
		runtimeV2Keys.privateKey,
	).toString("base64url");
	return {
		...request,
		grant: {
			schemaVersion: 2 as const,
			format: "runtime-execution-jws" as const,
			token: `${header}.${payload}.${signature}`,
		},
	};
}
