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
	RuntimeBusinessGrantClaimsV6Schema,
	type RuntimeBusinessRequestV4,
	type RuntimeEventAckRequestV4,
	type RuntimeEventReadRequestV4,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeExecutionGrantV2Schema,
	RuntimeExecutionGrantV4Schema,
	RuntimeExecutionGrantV5Schema,
	RuntimeExecutionGrantV6Schema,
	type RuntimeNativeCapabilityRequestV5,
	type RuntimeNativeCapabilityRequestV6,
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV4Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	type RuntimeRestoreExecutionKeyRequestV4,
	type RuntimeRestoreExecutionKeyRequestV5,
	runtimeEventRequestDigestV4,
	runtimeRequestDigestV5,
	runtimeRequestDigestV6,
	runtimeRequestSigningPayloadV4,
	runtimeRestoreExecutionKeyRequestDigestV4,
	runtimeRestoreExecutionKeyRequestDigestV5,
	validateRuntimeBusinessBindingV6,
	validateVerifiedRuntimeExecutionGrantClaimsV2,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
	validateVerifiedRuntimeExecutionGrantClaimsV6,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5,
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
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: options.keyId,
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	function tokenFor(claims: unknown) {
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signingInput = `${header}.${payload}`;
		return `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), options.privateKey).toString("base64url")}`;
	}
	return {
		async signV6(
			value: RuntimeNativeCapabilityRequestV6,
			authorizationRecordId: string,
		) {
			const request = RuntimeNativeCapabilityRequestV6Schema.parse(value);
			const issuedAt = now();
			const claims = RuntimeBusinessGrantClaimsV6Schema.parse({
				schemaVersion: 6,
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
				allowedCommands: ["native-capability.invoke"],
				purpose: "business",
				authorizationRecordId,
				attachments: [],
				requestDigest: await runtimeRequestDigestV6(request),
			});
			validateVerifiedRuntimeExecutionGrantClaimsV6(claims, {
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				now: now(),
			});
			await validateRuntimeBusinessBindingV6(request, claims);
			return RuntimeExecutionGrantV6Schema.parse({
				schemaVersion: 6,
				format: "runtime-execution-jws",
				token: tokenFor(claims),
			});
		},
		verifyV6(value: RuntimeNativeCapabilityRequestV6["grant"]) {
			try {
				const grant = RuntimeExecutionGrantV6Schema.parse(value);
				const [headerPart, payloadPart, signaturePart] = grant.token.split(".");
				if (
					headerPart !== header ||
					!payloadPart ||
					!signaturePart ||
					!verify(
						null,
						Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
						publicKey,
						decode(signaturePart),
					)
				)
					throw new Error();
				return validateVerifiedRuntimeExecutionGrantClaimsV6(
					JSON.parse(utf8.decode(decode(payloadPart))),
					{
						expectedIssuer: options.issuer,
						expectedWorkerId: options.workerId,
						now: now(),
					},
				);
			} catch {
				throw new TypeError("Runtime V6 grant is invalid");
			}
		},
		async signRecovery(
			originalRequest: RuntimeRestoreExecutionKeyRequestV4["originalRequest"],
			acceptedHostSessionRef: string,
			acceptedOperationDigest: string,
			authorizationRecordId: string,
		) {
			if (!authorizationRecordId || !acceptedHostSessionRef)
				throw new TypeError("Runtime V4 recovery authorization is required");
			const unsigned: RuntimeRestoreExecutionKeyRequestV4 = {
				schemaVersion: 4,
				mode: "existing-accepted-only",
				acceptedHostSessionRef,
				acceptedOperationDigest,
				grant: {
					schemaVersion: 4,
					format: "runtime-execution-jws",
					token: "unsigned.unsigned.unsigned",
				},
				originalRequest,
			};
			const issuedAt = now();
			const requestDigest =
				await runtimeRestoreExecutionKeyRequestDigestV4(unsigned);
			const claims = RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse({
				schemaVersion: 4,
				issuer: options.issuer,
				audience: "runtime_host",
				issuedAt,
				expiresAt: issuedAt + 30_000,
				grantId: (options.id ?? randomUUID)(),
				workerId: options.workerId,
				principal: originalRequest.principal,
				executionSource: originalRequest.executionSource,
				relayKeyBinding: originalRequest.keyBinding,
				agentId: originalRequest.agentId,
				channelId: originalRequest.channelId,
				conversationId: originalRequest.conversationId,
				executionId: originalRequest.executionId,
				turnId: originalRequest.turnId,
				sessionGeneration: originalRequest.sessionGeneration,
				traceId: originalRequest.traceId,
				hostSessionRef: originalRequest.hostSessionRef,
				operation: originalRequest.operation,
				allowedCommands: ["execution.key.restore"],
				purpose: "business",
				authorizationRecordId,
				attachments: [],
				requestDigest,
				mode: unsigned.mode,
				acceptedHostSessionRef,
				acceptedOperationDigest,
			});
			validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4(claims, {
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				now: issuedAt,
			});
			const grant = RuntimeExecutionGrantV4Schema.parse({
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: tokenFor(claims),
			});
			return { request: { ...unsigned, grant }, claims };
		},
		async signV5(
			request: RuntimeNativeCapabilityRequestV5,
			authorizationRecordId: string,
		) {
			if (!authorizationRecordId)
				throw new TypeError("Runtime V5 business authorization is required");
			if (
				request.capabilityKind !== "skill" ||
				request.attachments.length < 1 ||
				request.attachments.length > 4 ||
				new Set(request.attachments.map((entry) => entry.attachmentId)).size !==
					request.attachments.length ||
				request.operation.kind !== "execution" ||
				request.operation.id !== request.executionId ||
				request.keyBinding.purpose !==
					(request.executionSource === "web" ||
					request.executionSource === "wecom"
						? "personal"
						: "agent-default")
			)
				throw new TypeError("Runtime V5 business binding is invalid");
			const issuedAt = now();
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
				allowedCommands: ["native-capability.invoke"],
				purpose: "business",
				authorizationRecordId,
				attachments: request.attachments.map((entry) => ({
					attachmentId: entry.attachmentId,
					operations: ["read"] as const,
				})),
				requestDigest: await runtimeRequestDigestV5(request),
			});
			validateVerifiedRuntimeExecutionGrantClaimsV4(claims, {
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				now: issuedAt,
			});
			// V5 reuses the V4 business Grant wrapper and claims; only the request,
			// private Key field and operation identity are V5.
			return RuntimeExecutionGrantV4Schema.parse({
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: tokenFor(claims),
			});
		},
		async signRecoveryV5(
			originalRequest: RuntimeRestoreExecutionKeyRequestV5["originalRequest"],
			acceptedHostSessionRef: string,
			acceptedOperationDigest: string,
			acceptedAttachmentIds: readonly string[],
			authorizationRecordId: string,
		) {
			if (!authorizationRecordId || !acceptedHostSessionRef)
				throw new TypeError("Runtime V5 recovery authorization is required");
			const unsigned: RuntimeRestoreExecutionKeyRequestV5 = {
				schemaVersion: 5,
				mode: "existing-accepted-only",
				acceptedHostSessionRef,
				acceptedOperationDigest,
				acceptedAttachmentIds: [...acceptedAttachmentIds],
				grant: {
					schemaVersion: 5,
					format: "runtime-execution-jws",
					token: "unsigned.unsigned.unsigned",
				},
				originalRequest,
			};
			const issuedAt = now();
			const requestDigest =
				await runtimeRestoreExecutionKeyRequestDigestV5(unsigned);
			const claims = RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse({
				schemaVersion: 5,
				issuer: options.issuer,
				audience: "runtime_host",
				issuedAt,
				expiresAt: issuedAt + 30_000,
				grantId: (options.id ?? randomUUID)(),
				workerId: options.workerId,
				principal: originalRequest.principal,
				executionSource: originalRequest.executionSource,
				relayKeyBinding: originalRequest.keyBinding,
				agentId: originalRequest.agentId,
				channelId: originalRequest.channelId,
				conversationId: originalRequest.conversationId,
				executionId: originalRequest.executionId,
				turnId: originalRequest.turnId,
				sessionGeneration: originalRequest.sessionGeneration,
				traceId: originalRequest.traceId,
				hostSessionRef: originalRequest.hostSessionRef,
				operation: originalRequest.operation,
				allowedCommands: ["execution.key.restore"],
				purpose: "business",
				authorizationRecordId,
				attachments: [],
				requestDigest,
				mode: unsigned.mode,
				acceptedHostSessionRef,
				acceptedOperationDigest,
				acceptedAttachmentIds: [...acceptedAttachmentIds],
			});
			validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5(claims, {
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				now: issuedAt,
			});
			const grant = RuntimeExecutionGrantV5Schema.parse({
				schemaVersion: 5,
				format: "runtime-execution-jws",
				token: tokenFor(claims),
			});
			return { request: { ...unsigned, grant }, claims };
		},
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
			validateVerifiedRuntimeExecutionGrantClaimsV2(claims, {
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				now: issuedAt,
			});
			return RuntimeExecutionGrantV2Schema.parse({
				schemaVersion: 2,
				format: "runtime-execution-jws",
				token: tokenFor(claims),
			});
		},
		sign(request: RuntimeBusinessRequestV4, authorizationRecordId: string) {
			if (!authorizationRecordId)
				throw new TypeError("Runtime V4 business authorization is required");
			const submit = "selection" in request;
			const native = "capabilityId" in request;
			const purpose =
				request.executionSource === "web" || request.executionSource === "wecom"
					? "personal"
					: "agent-default";
			if (
				request.keyBinding.purpose !== purpose ||
				request.keyBinding.subjectId !==
					(purpose === "personal" ? request.principal.id : request.agentId) ||
				(purpose === "personal" && request.principal.kind !== "user") ||
				request.operation.kind !==
					(submit || native ? "execution" : "message") ||
				((submit || native) && request.operation.id !== request.executionId)
			)
				throw new TypeError("Runtime V4 business binding is invalid");
			const issuedAt = now();
			const attachments = "input" in request ? request.input.attachments : [];
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
					submit
						? "turn.submit"
						: native
							? "native-capability.invoke"
							: "turn.supplement",
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
			return RuntimeExecutionGrantV4Schema.parse({
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: tokenFor(claims),
			});
		},
		verifyV5(grant: RuntimeNativeCapabilityRequestV5["grant"]) {
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
				return validateVerifiedRuntimeExecutionGrantClaimsV4(
					JSON.parse(utf8.decode(decode(payloadPart))),
					{
						expectedIssuer: options.issuer,
						expectedWorkerId: options.workerId,
						now: now(),
					},
				);
			} catch {
				throw new TypeError("Runtime V5 grant is invalid");
			}
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
