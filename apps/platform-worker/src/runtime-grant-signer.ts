import { createHash, type KeyObject, randomUUID, sign } from "node:crypto";

import {
	type RuntimeExecutionGrantClaimsV2,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeExecutionGrantV2Schema,
	type RuntimeSubmitTurnRequestV3,
	runtimeRequestSigningPayloadV3,
	validateVerifiedRuntimeExecutionGrantClaimsV2,
} from "@agent-infra/contracts/runtime";

export type WorkerRuntimeAuthorizationV2 =
	| { readonly purpose: "business"; readonly authorizationRecordId: string }
	| {
			readonly purpose: "control";
			readonly controlRecordId: string;
			readonly reason:
				| "stop"
				| "authorization_revoked"
				| "recovery"
				| "generation_isolation";
	  };

type Request = Omit<
	RuntimeSubmitTurnRequestV3,
	"grant" | "input" | "selection"
> & {
	readonly input?: RuntimeSubmitTurnRequestV3["input"];
	readonly consumer?: "platform_worker_persistence";
	readonly afterCursor?: string | null;
	readonly confirmedCursor?: string;
};

/** Called only after the trusted Worker has rechecked the original task's current authorization. */
export function createWorkerRuntimeGrantSignerV2(options: {
	readonly issuer: string;
	readonly workerId: string;
	readonly keyId: string;
	readonly privateKey: KeyObject;
	readonly now?: () => number;
	readonly id?: () => string;
}) {
	if (
		!options.issuer ||
		!options.workerId ||
		!options.keyId ||
		options.privateKey.type !== "private" ||
		options.privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new TypeError("Runtime grant signing options are invalid");
	return <T extends Request>(
		request: T,
		authority: WorkerRuntimeAuthorizationV2,
		command: RuntimeExecutionGrantClaimsV2["allowedCommands"][0],
	) => {
		const issuedAt = (options.now ?? Date.now)();
		const attachments = request.input?.attachments ?? [];
		if (new Set(attachments).size !== attachments.length)
			throw new TypeError("Runtime grant attachments must be unique");
		const claims = RuntimeExecutionGrantClaimsV2Schema.parse({
			schemaVersion: 2,
			issuer: options.issuer,
			audience: "runtime_host",
			issuedAt,
			expiresAt: issuedAt + 30_000,
			grantId: (options.id ?? randomUUID)(),
			workerId: options.workerId,
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
			...authority,
			requestDigest: createHash("sha256")
				.update(
					runtimeRequestSigningPayloadV3({ ...request, grant: undefined }),
				)
				.digest("hex"),
			...(authority.purpose === "business"
				? {
						attachments: attachments.map((attachmentId) => ({
							attachmentId,
							operations: ["read"],
						})),
					}
				: {}),
			...(command === "events.persist"
				? {
						eventAccess: {
							command,
							consumer: request.consumer,
							afterCursor: request.afterCursor,
						},
					}
				: command === "events.ack"
					? {
							eventAccess: {
								command,
								consumer: request.consumer,
								confirmedCursor: request.confirmedCursor,
							},
						}
					: {}),
		});
		validateVerifiedRuntimeExecutionGrantClaimsV2(claims, {
			expectedIssuer: options.issuer,
			expectedWorkerId: options.workerId,
			now: issuedAt,
		});
		const protectedPart = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: options.keyId,
				typ: "runtime-execution+jws",
			}),
		).toString("base64url");
		const claimsPart = Buffer.from(JSON.stringify(claims)).toString(
			"base64url",
		);
		const signingInput = `${protectedPart}.${claimsPart}`;
		const signature = sign(
			null,
			Buffer.from(signingInput, "ascii"),
			options.privateKey,
		).toString("base64url");
		return RuntimeExecutionGrantV2Schema.parse({
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: `${signingInput}.${signature}`,
		});
	};
}
