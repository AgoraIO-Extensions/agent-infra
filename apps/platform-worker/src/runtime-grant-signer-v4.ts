import {
	createHash,
	createPublicKey,
	type KeyObject,
	randomUUID,
	sign,
	verify,
} from "node:crypto";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	type RuntimeEventAckRequestV4,
	type RuntimeEventReadRequestV4,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeExecutionGrantV2Schema,
	RuntimeExecutionGrantV4Schema,
	runtimeEventRequestDigestV4,
	runtimeRequestSigningPayloadV4,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
} from "@agent-infra/contracts/runtime";

import type { WorkerRuntimeAuthorizationV2 } from "./runtime-grant-signer.js";

interface SignerOptionsV4 {
	readonly issuer: string;
	readonly workerId: string;
	readonly keyId: string;
	readonly privateKey: KeyObject;
	readonly now?: () => number;
	readonly id?: () => string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decode(segment: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error();
	const bytes = Buffer.from(segment, "base64url");
	if (bytes.toString("base64url") !== segment) throw new Error();
	return bytes;
}

export function createWorkerRuntimeGrantSignerV4(options: SignerOptionsV4) {
	if (
		!options.issuer ||
		!options.workerId ||
		!options.keyId ||
		options.privateKey.type !== "private" ||
		options.privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new TypeError("Runtime V4 grant signing options are invalid");
	const publicKey = createPublicKey(options.privateKey);
	const now = options.now ?? Date.now;
	return {
		async signEvent(
			request: RuntimeEventReadRequestV4 | RuntimeEventAckRequestV4,
			authority: WorkerRuntimeAuthorizationV2,
		) {
			const issuedAt = now();
			const read = "afterCursor" in request;
			const command = read ? "events.persist" : "events.ack";
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
				...(authority.purpose === "business" ? { attachments: [] } : {}),
				eventAccess: read
					? {
							command,
							consumer: request.consumer,
							afterCursor: request.afterCursor,
						}
					: {
							command,
							consumer: request.consumer,
							confirmedCursor: request.confirmedCursor,
						},
				requestDigest: await runtimeEventRequestDigestV4(request),
			});
			const header = Buffer.from(
				JSON.stringify({
					alg: "EdDSA",
					kid: options.keyId,
					typ: "runtime-execution+jws",
				}),
			).toString("base64url");
			const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
			const signingInput = `${header}.${payload}`;
			return RuntimeExecutionGrantV2Schema.parse({
				schemaVersion: 2,
				format: "runtime-execution-jws",
				token: `${signingInput}.${sign(
					null,
					Buffer.from(signingInput, "ascii"),
					options.privateKey,
				).toString("base64url")}`,
			});
		},
		sign(request: RuntimeBusinessRequestV4, authorizationRecordId: string) {
			if (!authorizationRecordId)
				throw new TypeError("Runtime V4 business authorization is required");
			const issuedAt = now();
			const attachments = request.input.attachments;
			if (new Set(attachments).size !== attachments.length)
				throw new TypeError("Runtime V4 grant attachments must be unique");
			const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
				schemaVersion: 4,
				issuer: options.issuer,
				audience: "runtime_host",
				issuedAt,
				expiresAt: issuedAt + 30_000,
				grantId: (options.id ?? randomUUID)(),
				workerId: options.workerId,
				principal: request.principal,
				executionSource: request.executionSource,
				relayKeyBinding: request.keyBinding,
				agentId: request.agentId,
				channelId: request.channelId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				traceId: request.traceId,
				hostSessionRef: request.hostSessionRef,
				operation: request.operation,
				allowedCommands: [
					"selection" in request ? "turn.submit" : "turn.supplement",
				],
				purpose: "business",
				authorizationRecordId,
				attachments: attachments.map((attachmentId) => ({
					attachmentId,
					operations: ["read"],
				})),
				requestDigest: createHash("sha256")
					.update(runtimeRequestSigningPayloadV4(request))
					.digest("hex"),
			});
			validateVerifiedRuntimeExecutionGrantClaimsV4(claims, {
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				now: issuedAt,
			});
			const header = Buffer.from(
				JSON.stringify({
					alg: "EdDSA",
					kid: options.keyId,
					typ: "runtime-execution+jws",
				}),
			).toString("base64url");
			const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
			const signingInput = `${header}.${payload}`;
			return RuntimeExecutionGrantV4Schema.parse({
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: `${signingInput}.${sign(
					null,
					Buffer.from(signingInput, "ascii"),
					options.privateKey,
				).toString("base64url")}`,
			});
		},
		verify(grant: RuntimeBusinessRequestV4["grant"]) {
			try {
				const parsed = RuntimeExecutionGrantV4Schema.parse(grant);
				const [headerPart, payloadPart, signaturePart, extra] =
					parsed.token.split(".");
				if (!headerPart || !payloadPart || !signaturePart || extra)
					throw new Error();
				const header = JSON.parse(utf8.decode(decode(headerPart))) as Record<
					string,
					unknown
				>;
				if (
					Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
					header.alg !== "EdDSA" ||
					header.kid !== options.keyId ||
					header.typ !== "runtime-execution+jws" ||
					!verify(
						null,
						Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
						publicKey,
						decode(signaturePart),
					)
				)
					throw new Error();
				const claims = validateVerifiedRuntimeExecutionGrantClaimsV4(
					JSON.parse(utf8.decode(decode(payloadPart))),
					{
						expectedIssuer: options.issuer,
						expectedWorkerId: options.workerId,
						now: now(),
					},
				);
				return claims;
			} catch {
				throw new TypeError("Runtime V4 grant is invalid");
			}
		},
	};
}
