import {
	createHash,
	type KeyObject,
	randomUUID,
	timingSafeEqual,
	verify,
} from "node:crypto";
import { type RuntimeHost, RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	type RuntimeOriginalAdmissionCheckBindingV1,
	type RuntimeOriginalAdmissionCheckProofClaimsV1,
	RuntimeOriginalAdmissionCheckProofClaimsV1Schema,
	RuntimeOriginalAdmissionCheckRequestV1Schema,
	type RuntimeOriginalAdmissionCheckResponseV1,
	RuntimeOriginalAdmissionCheckResponseV1Schema,
	RuntimeOriginalAdmissionPodUidV1Schema,
	runtimeOriginalAdmissionCheckBindingPayloadV1,
	runtimeOriginalAdmissionCheckProofPayloadV1,
} from "@agent-infra/contracts/runtime";

/** JWS `typ` that separates this proof from every other use of the key. */
export const runtimeOriginalAdmissionCheckJwsTypeV1 =
	"runtime-original-admission-check+jws";

const ascii = /^[\x21-\x7e]{1,8192}$/;
const maximumChallenges = 4096;

function invalidProof(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Runtime authorization is unavailable or does not authorize this operation",
		403,
		false,
	);
}

function decode(value: string) {
	return Buffer.from(value, "base64url").toString("utf8");
}

function bindingOf(
	request: RuntimeOriginalAdmissionCheckBindingV1 & { proof?: unknown },
): RuntimeOriginalAdmissionCheckBindingV1 {
	const { proof: _proof, ...binding } = request;
	return binding;
}

function claimsBinding(
	claims: RuntimeOriginalAdmissionCheckProofClaimsV1,
): RuntimeOriginalAdmissionCheckBindingV1 {
	const {
		purpose: _purpose,
		audience: _audience,
		issuer: _issuer,
		workerId: _workerId,
		keyVersion: _keyVersion,
		requestDigest: _requestDigest,
		...binding
	} = claims;
	return binding;
}

export function runtimeOriginalAdmissionCheckDigestV1(
	binding: RuntimeOriginalAdmissionCheckBindingV1,
) {
	return createHash("sha256")
		.update(runtimeOriginalAdmissionCheckBindingPayloadV1(binding))
		.digest("hex");
}

export type RuntimeOriginalAdmissionCheckV1 = ReturnType<
	typeof createRuntimeOriginalAdmissionCheckV1
>;

/**
 * #4358 I3 (Spec §9.3.2): verify the Worker proof and run the read-only
 * original admission check against this Host's committed state. Nothing here
 * dispatches, binds, renews, recovers or writes Host state; only a bounded
 * in-memory challenge set is kept to refuse replays.
 */
export function createRuntimeOriginalAdmissionCheckV1(options: {
	readonly host: Pick<RuntimeHost, "checkOriginalAdmissionV1">;
	readonly publicKey: KeyObject;
	readonly issuer: string;
	readonly workerId: string;
	readonly keyVersion: string;
	readonly podUid: string;
	readonly instanceId?: string;
	readonly now?: () => number;
}) {
	const podUid = options.podUid.toLowerCase();
	if (
		options.publicKey.type !== "public" ||
		options.publicKey.asymmetricKeyType !== "ed25519" ||
		!ascii.test(options.issuer) ||
		!ascii.test(options.workerId) ||
		!ascii.test(options.keyVersion) ||
		!RuntimeOriginalAdmissionPodUidV1Schema.safeParse(podUid).success
	)
		throw new TypeError("Runtime original admission check is invalid");
	const now = options.now ?? Date.now;
	const clockId = createHash("sha256")
		.update(`${podUid}\n${options.instanceId ?? randomUUID()}`)
		.digest("base64url")
		.slice(0, 22);
	const canonicalHeader = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: options.keyVersion,
			typ: runtimeOriginalAdmissionCheckJwsTypeV1,
		}),
		"utf8",
	).toString("base64url");
	const challenges = new Map<string, number>();

	function verifyProof(
		binding: RuntimeOriginalAdmissionCheckBindingV1,
		token: string,
		at: number,
	) {
		const parts = token.split(".");
		const [header, payload, signature] = parts;
		if (parts.length !== 3 || !header || !payload || !signature) invalidProof();
		if (header !== canonicalHeader) invalidProof();
		const signed = Buffer.from(`${header}.${payload}`, "ascii");
		const bytes = Buffer.from(signature, "base64url");
		if (bytes.length !== 64 || !verify(null, signed, options.publicKey, bytes))
			invalidProof();
		const parsed = RuntimeOriginalAdmissionCheckProofClaimsV1Schema.safeParse(
			JSON.parse(decode(payload)),
		);
		if (!parsed.success) invalidProof();
		const claims = parsed.data;
		const canonical = Buffer.from(
			Buffer.from(
				runtimeOriginalAdmissionCheckProofPayloadV1(claims),
				"utf8",
			).toString("base64url"),
		);
		const supplied = Buffer.from(payload);
		if (
			claims.issuer !== options.issuer ||
			claims.workerId !== options.workerId ||
			claims.keyVersion !== options.keyVersion ||
			claims.requestDigest !== runtimeOriginalAdmissionCheckDigestV1(binding) ||
			runtimeOriginalAdmissionCheckBindingPayloadV1(claimsBinding(claims)) !==
				runtimeOriginalAdmissionCheckBindingPayloadV1(binding) ||
			claims.issuedAt > at ||
			claims.expiresAt <= at ||
			supplied.length !== canonical.length ||
			!timingSafeEqual(supplied, canonical)
		)
			invalidProof();
	}

	return {
		clockId,
		async check(
			input: unknown,
		): Promise<RuntimeOriginalAdmissionCheckResponseV1> {
			const parsed =
				RuntimeOriginalAdmissionCheckRequestV1Schema.safeParse(input);
			if (!parsed.success)
				throw new RuntimeHostError(
					"RUNTIME_REQUEST_INVALID",
					"Runtime request is invalid",
					400,
				);
			const request = parsed.data;
			const binding = bindingOf(request);
			const at = now();
			if (!Number.isSafeInteger(at)) invalidProof();
			verifyProof(binding, request.proof.token, at);
			for (const [value, expiresAt] of challenges)
				if (expiresAt <= at) challenges.delete(value);
			if (challenges.has(request.challenge))
				throw new RuntimeHostError(
					"RUNTIME_ADMISSION_CHECK_REPLAYED",
					"Runtime admission check challenge was already used",
					409,
					false,
				);
			if (challenges.size >= maximumChallenges)
				throw new RuntimeHostError(
					"RUNTIME_ADMISSION_CHECK_UNAVAILABLE",
					"Runtime admission check is unavailable",
					503,
					true,
				);
			challenges.set(request.challenge, request.expiresAt);
			const respond = (
				result: Pick<
					RuntimeOriginalAdmissionCheckResponseV1,
					"decision" | "reason"
				> &
					Pick<
						RuntimeOriginalAdmissionCheckResponseV1["current"],
						"hostBarrier" | "hostExecutionFence"
					>,
			) =>
				RuntimeOriginalAdmissionCheckResponseV1Schema.parse({
					schemaVersion: 1,
					checkId: request.checkId,
					challenge: request.challenge,
					decision: result.decision,
					...(result.reason ? { reason: result.reason } : {}),
					checkedSurface: "original_call_admission_predicate",
					original: {
						sessionGeneration: request.scope.sessionGeneration,
						executionDeliveryFence: request.scope.executionDeliveryFence,
					},
					current: {
						platformSessionGeneration: request.platform.sessionGeneration,
						platformResourceFence: request.platform.resourceFence,
						hostBarrier: result.hostBarrier,
						hostExecutionFence: result.hostExecutionFence,
					},
					checkedAt: at,
					clockId,
					dispatchAttempted: false,
				});
			// A replacement Pod with the same name cannot answer for the original Host.
			if (request.scope.podUid !== podUid)
				return respond({
					decision: "unproven",
					reason: "original_binding_unavailable",
					hostBarrier: "unavailable",
					hostExecutionFence: null,
				});
			const result = await options.host.checkOriginalAdmissionV1(
				request.scope,
				request.platform.sessionGeneration,
			);
			if (now() >= request.expiresAt)
				return respond({
					decision: "unproven",
					reason: "unknown",
					hostBarrier: result.hostBarrier,
					hostExecutionFence: result.hostExecutionFence,
				});
			return respond(result);
		},
	};
}
