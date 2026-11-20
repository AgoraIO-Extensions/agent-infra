import {
	createHash,
	createPublicKey,
	type KeyObject,
	randomBytes,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	parseSessionInstanceJsonV1,
	SessionInstanceEvidenceClaimsV1Schema,
	SessionInstanceEvidenceV1Schema,
	type SessionInstanceReadBodyV1,
	SessionInstanceReadBodyV1Schema,
	SessionInstanceReadClaimsV1Schema,
	sessionInstanceReadPathV1,
	sessionInstanceReadSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import type { SessionSandboxInstanceEvidenceV1 } from "@agent-infra/platform-core";

/** The caller supplies only the original DB/Pod facts, never an origin or key from a response. */
export async function readSessionReserveInstanceV1(options: {
	readonly binding: Omit<
		SessionInstanceReadBodyV1,
		"requestId" | "traceId" | "nonce"
	>;
	readonly hostKeyId: string;
	readonly hostPublicKey: string;
	readonly expectedRunnerEpoch?: string;
	readonly serviceToken: string;
	readonly origin: string;
	readonly signing: {
		readonly workerId: string;
		readonly issuer: string;
		readonly keyId: string;
		readonly privateKey: KeyObject;
	};
	readonly revalidate: () => Promise<void>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
}): Promise<SessionSandboxInstanceEvidenceV1 | null> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const now = options.now ?? Date.now;
		const origin = new URL(options.origin);
		if (
			origin.protocol !== "http:" ||
			origin.username ||
			origin.password ||
			origin.search ||
			origin.hash ||
			origin.pathname !== "/" ||
			options.signing.workerId !== options.binding.workerId ||
			options.signing.privateKey.asymmetricKeyType !== "ed25519"
		)
			return null;
		await options.revalidate();
		options.signal?.throwIfAborted();
		const request = SessionInstanceReadBodyV1Schema.parse({
			...options.binding,
			requestId: randomUUID(),
			traceId: randomUUID(),
			nonce: randomBytes(24).toString("base64url"),
		});
		const issuedAt = now();
		const claims = SessionInstanceReadClaimsV1Schema.parse({
			issuer: options.signing.issuer,
			audience: "runtime_host_session_instance",
			purpose: "session-instance-read-v1",
			workerId: request.workerId,
			issuedAt,
			expiresAt: issuedAt + 10_000,
			requestDigest: createHash("sha256")
				.update(sessionInstanceReadSigningPayloadV1(request))
				.digest("hex"),
		});
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: options.signing.keyId,
				typ: claims.purpose,
			}),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signed = `${header}.${payload}`;
		const authorization = `${signed}.${sign(null, Buffer.from(signed), options.signing.privateKey).toString("base64url")}`;
		const response = await (options.fetch ?? fetch)(
			new URL(sessionInstanceReadPathV1, origin),
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${options.serviceToken}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({ ...request, authorization }),
				redirect: "error",
				credentials: "omit",
				cache: "no-store",
				signal: options.signal
					? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
					: AbortSignal.timeout(10_000),
			},
		);
		if (
			response.status !== 200 ||
			response.redirected ||
			!/^application\/json(?:\s*;|$)/i.test(
				response.headers.get("content-type") ?? "",
			)
		) {
			await response.body?.cancel();
			return null;
		}
		reader = response.body?.getReader();
		if (!reader) return null;
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 32_768) return null;
			chunks.push(next.value);
		}
		const proof = SessionInstanceEvidenceV1Schema.parse(
			parseSessionInstanceJsonV1(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			),
		);
		const { signature, ...body } = proof;
		const [head, content, seal, extra] = signature.split(".");
		if (!head || !content || !seal || extra) return null;
		const decode = (value: string) => {
			const buffer = Buffer.from(value, "base64url");
			if (buffer.toString("base64url") !== value)
				throw new Error("invalid encoding");
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		};
		const protectedHeader = parseSessionInstanceJsonV1(decode(head));
		if (
			!isDeepStrictEqual(protectedHeader, {
				alg: "EdDSA",
				kid: options.hostKeyId,
				typ: "session-instance-evidence-v1",
			})
		)
			return null;
		const verified = SessionInstanceEvidenceClaimsV1Schema.parse(
			parseSessionInstanceJsonV1(decode(content)),
		);
		if (
			!isDeepStrictEqual(verified, {
				...body,
				purpose: "session-instance-evidence-v1",
				audience: request.workerId,
			}) ||
			!verify(
				null,
				Buffer.from(`${head}.${content}`),
				createPublicKey({
					key: Buffer.from(options.hostPublicKey, "base64url"),
					format: "der",
					type: "spki",
				}),
				Buffer.from(seal, "base64url"),
			)
		)
			return null;
		const {
			requestDigest,
			hostKeyId,
			runnerEpoch,
			observedAt,
			expiresAt,
			checks: _checks,
			...responseBinding
		} = body;
		if (
			!isDeepStrictEqual(responseBinding, request) ||
			requestDigest !== claims.requestDigest ||
			hostKeyId !== options.hostKeyId ||
			(options.expectedRunnerEpoch &&
				runnerEpoch !== options.expectedRunnerEpoch) ||
			observedAt < issuedAt ||
			observedAt > now() ||
			expiresAt > claims.expiresAt ||
			now() >= expiresAt
		)
			return null;
		await options.revalidate();
		options.signal?.throwIfAborted();
		if (now() >= expiresAt) return null;
		return {
			scope: body.scope,
			podUid: body.podUid,
			hostKeyId,
			runnerEpoch,
			generation: body.generation,
			resourceFence: body.resourceFence,
			issuedAtMs: issuedAt,
			observedAtMs: observedAt,
			expiresAtMs: expiresAt,
		};
	} catch {
		return null;
	} finally {
		await reader?.cancel().catch(() => {});
	}
}
