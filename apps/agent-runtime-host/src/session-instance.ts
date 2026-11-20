import { createHash, type KeyObject, sign, verify } from "node:crypto";
import {
	type CodexSessionExecutorBindingV1,
	codexSessionExecutorBindingDigestV1,
	type ExecutorIdentityV1,
	RuntimeHostError,
	verifiedExecutorInstanceIdentityV2,
} from "@agent-infra/agent-runtime";
import {
	canonicalRuntimeRequestSigningPayload,
	parseSessionInstanceJsonV1,
	SessionInstanceEvidenceClaimsV1Schema,
	type SessionInstanceEvidenceV1,
	SessionInstanceEvidenceV1Schema,
	type SessionInstanceReadClaimsV1,
	SessionInstanceReadClaimsV1Schema,
	type SessionInstanceReadRequestV1,
	SessionInstanceReadRequestV1Schema,
	sessionInstanceReadSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import {
	executorIdentityConsumedV1,
	executorIdentityDeliveryRemovedV1,
} from "./executor-identity-startup.js";

function denied(): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_INSTANCE_DENIED",
		"Session instance read is not authorized",
		403,
	);
}
function unavailable(): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
		"Session instance evidence is unavailable",
		503,
		true,
	);
}
function invalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_REQUEST_INVALID",
		"Runtime request is invalid",
		400,
	);
}

export async function readSessionInstanceBodyV1(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) invalid();
	try {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			bytes += item.value.byteLength;
			if (bytes > 65_536) {
				void reader.cancel().catch(() => {});
				invalid();
			}
			chunks.push(item.value);
		}
		return SessionInstanceReadRequestV1Schema.parse(
			parseSessionInstanceJsonV1(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			),
		);
	} catch {
		return invalid();
	} finally {
		reader.releaseLock();
	}
}

function decode(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) denied();
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value) denied();
	return bytes;
}

export interface SessionInstancePreparationFactsV1 {
	readonly runnerEpoch: string;
	readonly runnerIdentityConsumed: boolean;
	readonly deliveryFilesRemoved: boolean;
	readonly executorReady: boolean;
	readonly emptyBusinessState: boolean;
}

/** Explicit Host-only construction; production assembly supplies no enabling configuration. */
export function createSessionInstanceReaderV1(options: {
	readonly identity: ExecutorIdentityV1;
	readonly binding: CodexSessionExecutorBindingV1;
	readonly podUid: string;
	readonly runnerEpoch: string;
	readonly profileDigest: string;
	readonly hostKeyId: string;
	readonly worker: {
		readonly issuer: string;
		readonly workerId: string;
		readonly keyId: string;
		readonly publicKey: KeyObject;
	};
	readonly readPreparation: (
		signal: AbortSignal,
	) => Promise<SessionInstancePreparationFactsV1>;
	readonly isBusinessStateEmpty: () => boolean;
	readonly now?: () => number;
}) {
	const identity = verifiedExecutorInstanceIdentityV2(options.identity);
	const bindingDigest = codexSessionExecutorBindingDigestV1(options.binding);
	if (
		identity.role !== "host" ||
		identity.podUid !== options.podUid ||
		identity.bindingDigest !== bindingDigest ||
		identity.instance.sandboxId !== options.binding.sandboxId ||
		identity.instance.generation !== options.binding.sessionGeneration ||
		identity.instance.resourceFence !== options.binding.resourceFence
	)
		denied();
	if (!executorIdentityConsumedV1(identity)) unavailable();
	const worker = Object.freeze({ ...options.worker });
	if (
		worker.publicKey.type !== "public" ||
		worker.publicKey.asymmetricKeyType !== "ed25519" ||
		!worker.issuer ||
		!worker.workerId ||
		!worker.keyId ||
		!options.hostKeyId ||
		!options.runnerEpoch ||
		!/^[a-f0-9]{64}$/.test(options.profileDigest)
	)
		unavailable();
	const local = Object.freeze({
		workerId: worker.workerId,
		namespace: options.binding.namespace,
		agentId: options.binding.agentId,
		sessionId: options.binding.conversationId,
		sandboxId: options.binding.sandboxId,
		podUid: options.podUid,
		generation: options.binding.sessionGeneration,
		resourceFence: options.binding.resourceFence,
		startupRef: identity.startupRef,
		bindingDigest,
		profileDigest: options.profileDigest,
	});
	const runnerEpoch = options.runnerEpoch;
	const hostKeyId = options.hostKeyId;
	const now = options.now ?? Date.now;
	const nonces = new Map<string, number>();
	return async (
		input: unknown,
		signal?: AbortSignal,
	): Promise<SessionInstanceEvidenceV1> => {
		let request: SessionInstanceReadRequestV1;
		try {
			request = SessionInstanceReadRequestV1Schema.parse(input);
		} catch {
			return invalid();
		}
		const { authorization: _authorization, ...body } = request;
		let claims: SessionInstanceReadClaimsV1;
		const requestDigest = createHash("sha256")
			.update(sessionInstanceReadSigningPayloadV1(body))
			.digest("hex");
		try {
			const parts = request.authorization.split(".");
			if (parts.length !== 3) denied();
			const [h, p, s] = parts;
			if (!h || !p || !s) denied();
			const header = parseSessionInstanceJsonV1(
				new TextDecoder("utf-8", { fatal: true }).decode(decode(h)),
			) as Record<string, unknown>;
			if (
				!header ||
				Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
				header.alg !== "EdDSA" ||
				header.typ !== "session-instance-read-v1" ||
				header.kid !== worker.keyId
			)
				denied();
			const signature = decode(s);
			if (
				signature.length !== 64 ||
				!verify(
					null,
					Buffer.from(`${h}.${p}`, "ascii"),
					worker.publicKey,
					signature,
				)
			)
				denied();
			claims = SessionInstanceReadClaimsV1Schema.parse(
				parseSessionInstanceJsonV1(
					new TextDecoder("utf-8", { fatal: true }).decode(decode(p)),
				),
			);
		} catch {
			return denied();
		}
		const current = () => {
			const at = now();
			if (
				!Number.isSafeInteger(at) ||
				claims.issuer !== worker.issuer ||
				claims.workerId !== worker.workerId ||
				claims.issuedAt > at ||
				claims.expiresAt <= at ||
				claims.expiresAt <= claims.issuedAt ||
				claims.expiresAt - claims.issuedAt > 30_000 ||
				claims.requestDigest !== requestDigest ||
				Object.entries(local).some(
					([key, value]) => request[key as keyof typeof local] !== value,
				)
			)
				denied();
			return at;
		};
		const at = current();
		for (const [key, expiresAt] of nonces)
			if (expiresAt <= at) nonces.delete(key);
		const nonce = createHash("sha256")
			.update(JSON.stringify([worker.workerId, request.nonce]))
			.digest("hex");
		if (nonces.has(nonce)) denied();
		if (nonces.size >= 4096) unavailable();
		nonces.set(nonce, claims.expiresAt);
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) controller.abort();
		const timer = setTimeout(cancel, claims.expiresAt - at);
		const abort = new Promise<never>((_resolve, reject) => {
			if (controller.signal.aborted) reject(new Error());
			else
				controller.signal.addEventListener("abort", () => reject(new Error()), {
					once: true,
				});
		});
		let facts: SessionInstancePreparationFactsV1;
		let removed: boolean;
		try {
			({ facts, removed } = await Promise.race([
				(async () => ({
					facts: await options.readPreparation(controller.signal),
					removed: await executorIdentityDeliveryRemovedV1(identity),
				}))(),
				abort,
			]));
		} catch {
			current();
			return unavailable();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			controller.abort();
		}
		const observedAt = current();
		if (!facts || typeof facts !== "object") unavailable();
		if (facts.runnerEpoch !== runnerEpoch) denied();
		try {
			if (
				removed !== true ||
				facts.runnerIdentityConsumed !== true ||
				facts.deliveryFilesRemoved !== true ||
				facts.executorReady !== true ||
				facts.emptyBusinessState !== true ||
				options.isBusinessStateEmpty() !== true
			)
				unavailable();
		} catch {
			return unavailable();
		}
		const response = {
			...body,
			requestDigest,
			hostKeyId,
			runnerEpoch,
			observedAt,
			expiresAt: claims.expiresAt,
			checks: {
				hostIdentityConsumed: true as const,
				runnerIdentityConsumed: true as const,
				deliveryFilesRemoved: true as const,
				executorReady: true as const,
				emptyBusinessState: true as const,
			},
		};
		const signed = SessionInstanceEvidenceClaimsV1Schema.parse({
			...response,
			purpose: "session-instance-evidence-v1",
			audience: worker.workerId,
		});
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				typ: "session-instance-evidence-v1",
				kid: hostKeyId,
			}),
		).toString("base64url");
		const payload = Buffer.from(
			canonicalRuntimeRequestSigningPayload({ ...signed, grant: undefined }),
		).toString("base64url");
		const signingInput = `${header}.${payload}`;
		const signature = `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), identity.privateKey).toString("base64url")}`;
		return SessionInstanceEvidenceV1Schema.parse({ ...response, signature });
	};
}
