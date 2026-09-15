import { type KeyObject, sign, verify } from "node:crypto";
import {
	FileAccessClaimsV1Schema,
	type FileAccessGrantV1,
	FileAccessGrantV1Schema,
} from "@agent-infra/contracts/files";
import { validateVerifiedExecutionGrantClaimsV1 } from "@agent-infra/contracts/pilot";
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
