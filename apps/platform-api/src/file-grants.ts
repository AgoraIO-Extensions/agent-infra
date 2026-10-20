import { type KeyObject, sign, verify } from "node:crypto";
import {
	FileAccessClaimsV1Schema,
	type FileAccessGrantV1,
	FileAccessGrantV1Schema,
} from "@agent-infra/contracts/files";
import { validateVerifiedExecutionGrantClaimsV1 } from "@agent-infra/contracts/pilot";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantMaximumLifetimeMsV4,
	RuntimeExecutionGrantV4Schema,
} from "@agent-infra/contracts/runtime";
import type { FileAccessRecordV1 } from "@agent-infra/platform-core";

function invalid(): never {
	throw new Error("File authorization is invalid");
}
const decoder = new TextDecoder("utf-8", { fatal: true });
function decode(value: string) {
	const bytes = Buffer.from(value, "base64url");
	if (!/^[A-Za-z0-9_-]+$/.test(value) || bytes.toString("base64url") !== value)
		invalid();
	return bytes;
}
function verifiedPayload(
	input: unknown,
	publicKeys: ReadonlyMap<string, KeyObject>,
): unknown {
	try {
		const envelope = FileAccessGrantV1Schema.parse(input);
		if (envelope.token.length > 16384) invalid();
		const [header, payload, signature] = envelope.token.split(".");
		if (!header || !payload || !signature) invalid();
		const parsed = JSON.parse(decoder.decode(decode(header)));
		if (
			!parsed ||
			Object.keys(parsed).sort().join(",") !== "alg,kid" ||
			parsed.alg !== "EdDSA" ||
			typeof parsed.kid !== "string"
		)
			invalid();
		const key = publicKeys.get(parsed.kid);
		if (
			key?.asymmetricKeyType !== "ed25519" ||
			!verify(null, Buffer.from(`${header}.${payload}`), key, decode(signature))
		)
			invalid();
		return JSON.parse(decoder.decode(decode(payload)));
	} catch {
		invalid();
	}
}
function verifiedRuntimePayloadV4(
	input: unknown,
	publicKeys: ReadonlyMap<string, KeyObject>,
): unknown {
	try {
		const envelope = RuntimeExecutionGrantV4Schema.parse(input);
		const [header, payload, signature] = envelope.token.split(".");
		if (!header || !payload || !signature) invalid();
		const parsed = JSON.parse(decoder.decode(decode(header)));
		if (
			!parsed ||
			Object.keys(parsed).sort().join(",") !== "alg,kid,typ" ||
			parsed.alg !== "EdDSA" ||
			parsed.typ !== "runtime-execution+jws" ||
			typeof parsed.kid !== "string"
		)
			invalid();
		const key = publicKeys.get(parsed.kid);
		if (
			key?.asymmetricKeyType !== "ed25519" ||
			!verify(null, Buffer.from(`${header}.${payload}`), key, decode(signature))
		)
			invalid();
		return JSON.parse(decoder.decode(decode(payload)));
	} catch {
		invalid();
	}
}
export function verifyExecutionGrantForFilesV1(
	input: unknown,
	options: {
		issuer: string;
		publicKeys: ReadonlyMap<string, KeyObject>;
		now: string;
	},
) {
	try {
		const claims = validateVerifiedExecutionGrantClaimsV1(
			verifiedPayload(input, options.publicKeys),
			{
				expectedIssuer: options.issuer,
				requiredAudience: "runtime_host",
				now: options.now,
			},
		);
		if (
			!claims.allowedCommands.some(
				(command) => command === "turn.submit" || command === "turn.supplement",
			)
		)
			invalid();
		return claims;
	} catch {
		invalid();
	}
}

/**
 * Verifies the original signed V4 Execution Grant that a RuntimeHost/Worker
 * received for one business operation. The V4 header carries `typ` in addition
 * to `alg`/`kid`, so the legacy V1 envelope check cannot accept it.
 *
 * The Grant is a delegation-scope proof, not continuous authority: its
 * cryptographically signed lifetime is validated structurally (< 30 s), but
 * the exchange deliberately does not require it to still be wall-clock fresh.
 * Current authorization is enforced against persisted conversation, Execution,
 * delivery fence, stop and task-authorization facts; a 30 s proof would
 * otherwise make result writes of longer turns fail by construction.
 */
export function verifyRuntimeExecutionGrantForFilesV4(
	input: unknown,
	options: {
		issuer: string;
		workerId: string;
		publicKeys: ReadonlyMap<string, KeyObject>;
	},
) {
	try {
		const claims = RuntimeBusinessGrantClaimsV4Schema.parse(
			verifiedRuntimePayloadV4(input, options.publicKeys),
		);
		const command = claims.allowedCommands[0];
		if (
			!options.issuer ||
			!options.workerId ||
			claims.issuer !== options.issuer ||
			claims.workerId !== options.workerId ||
			(command !== "turn.submit" && command !== "turn.supplement") ||
			claims.expiresAt <= claims.issuedAt ||
			claims.expiresAt - claims.issuedAt >
				RuntimeExecutionGrantMaximumLifetimeMsV4
		)
			invalid();
		// The execution-bound submit names the Execution and a fence; the
		// supplement proof names its Message and has no comparable persisted
		// Message fence in this milestone (OQ-3 in #2968).
		if (command === "turn.submit") {
			if (
				claims.operation.kind !== "execution" ||
				claims.operation.id !== claims.executionId ||
				claims.operation.deliveryFence !==
					claims.operation.executionDeliveryFence
			)
				invalid();
		} else if (claims.operation.kind !== "message") invalid();
		return claims;
	} catch {
		invalid();
	}
}
export function createFileGrantCodecV1(options: {
	issuer: string;
	keyVersion: string;
	privateKey: KeyObject;
	publicKeys: ReadonlyMap<string, KeyObject>;
}) {
	if (
		options.privateKey.asymmetricKeyType !== "ed25519" ||
		!options.issuer ||
		!options.keyVersion
	)
		invalid();
	return {
		sign(record: FileAccessRecordV1): FileAccessGrantV1 {
			if (
				record.issuer !== options.issuer ||
				record.keyVersion !== options.keyVersion
			)
				invalid();
			const { keyVersion: _, idempotencyKey: _key, ...input } = record;
			const claims = FileAccessClaimsV1Schema.parse(input);
			const header = Buffer.from(
				JSON.stringify({ alg: "EdDSA", kid: options.keyVersion }),
			).toString("base64url");
			const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
			const content = `${header}.${payload}`;
			return {
				schemaVersion: 1,
				format: "compact-jws",
				token: `${content}.${sign(null, Buffer.from(content), options.privateKey).toString("base64url")}`,
			};
		},
		verify(input: unknown) {
			try {
				const claims = FileAccessClaimsV1Schema.parse(
					verifiedPayload(input, options.publicKeys),
				);
				if (
					claims.issuer !== options.issuer ||
					Date.parse(claims.expiresAt) <= Date.parse(claims.issuedAt)
				)
					invalid();
				return claims;
			} catch {
				invalid();
			}
		},
	};
}
