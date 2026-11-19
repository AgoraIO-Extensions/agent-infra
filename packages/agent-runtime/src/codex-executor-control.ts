import { createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { z } from "zod";
import type { ExecutorIdentityV1 } from "./codex-executor-start-identity.js";

const envelopeSchema = z.strictObject({
	sender: z.enum(["host", "runner"]),
	path: z.string().min(1).max(128),
	requestId: z.string().uuid(),
	deadline: z.number().int().positive().safe(),
	body: z.string().max(512_000),
	signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
type Envelope = z.infer<typeof envelopeSchema>;
const controlLifetimeMs = 60_000;
export const executorRunnerControlOriginV1 = "http://127.0.0.1:8068";
export const executorHostControlOriginV1 = "http://127.0.0.1:8069";

function bytes(
	identity: ExecutorIdentityV1,
	envelope: Omit<Envelope, "signature">,
) {
	return Buffer.from(
		JSON.stringify([
			"agent-infra/executor/control/v1",
			identity.podUid,
			identity.bindingDigest,
			identity.startupRef,
			envelope.sender,
			envelope.path,
			envelope.requestId,
			envelope.deadline,
			envelope.body,
		]),
	);
}

export function signExecutorControlV1(
	identity: ExecutorIdentityV1,
	path: string,
	body: unknown,
	requestId: string = randomUUID(),
	deadline = Date.now() + controlLifetimeMs,
) {
	const unsigned = {
		sender: identity.role,
		path,
		requestId,
		deadline,
		body: JSON.stringify(body),
	};
	return envelopeSchema.parse({
		...unsigned,
		signature: sign(
			null,
			bytes(identity, unsigned),
			identity.privateKey,
		).toString("base64url"),
	});
}

export function verifyExecutorControlV1(
	identity: ExecutorIdentityV1,
	path: string,
	input: unknown,
	requestId?: string,
) {
	const parsed = envelopeSchema.safeParse(input);
	const now = Date.now();
	if (!parsed.success) return null;
	const envelope = parsed.data;
	if (
		envelope.sender === identity.role ||
		envelope.path !== path ||
		envelope.deadline <= now ||
		envelope.deadline > now + controlLifetimeMs ||
		(requestId !== undefined && envelope.requestId !== requestId)
	)
		return null;
	try {
		const peer = createPublicKey({
			key: Buffer.from(identity.peerKey, "base64url"),
			format: "der",
			type: "spki",
		});
		if (
			peer.asymmetricKeyType !== "ed25519" ||
			!verify(
				null,
				bytes(identity, envelope),
				peer,
				Buffer.from(envelope.signature, "base64url"),
			)
		)
			return null;
		return { ...envelope, contents: JSON.parse(envelope.body) as unknown };
	} catch {
		return null;
	}
}

export async function executorControlRequestV1(
	identity: ExecutorIdentityV1,
	origin:
		| typeof executorRunnerControlOriginV1
		| typeof executorHostControlOriginV1,
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const request = signExecutorControlV1(identity, path, body);
	const response = await fetch(`${origin}${path}`, {
		method: "POST",
		body: JSON.stringify(request),
		headers: { "content-type": "application/json" },
		redirect: "error",
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(controlLifetimeMs)])
			: AbortSignal.timeout(controlLifetimeMs),
	});
	if (!response.ok || !response.body)
		throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			bytesRead += item.value.byteLength;
			if (bytesRead > 524_288)
				throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
			chunks.push(item.value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	const result = verifyExecutorControlV1(
		identity,
		`${path}/result`,
		JSON.parse(Buffer.concat(chunks).toString("utf8")),
		request.requestId,
	);
	if (!result) throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
	return result.contents;
}
