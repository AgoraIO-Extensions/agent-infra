import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { z } from "zod";

const token = z.string().min(1).max(256);
const encoded = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[A-Za-z0-9_-]+$/);
const startSchema = z.strictObject({
	podUid: token,
	bindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
	startupRef: token,
	expiresAt: z.number().int().positive().safe(),
});
const statementSchema = startSchema.extend({
	role: z.enum(["host", "runner"]),
	publicKey: encoded,
	peerKey: encoded,
});
const materialSchema = z.strictObject({
	statement: statementSchema,
	privateKey: encoded,
	signature: encoded,
});
export type ExecutorStartupBindingV1 = z.infer<typeof startSchema>;
type Startup = ExecutorStartupBindingV1;
type Statement = z.infer<typeof statementSchema>;
type Material = z.infer<typeof materialSchema>;
export type ExecutorIdentityV1 = Statement & { privateKey: KeyObject };

export const executorIdentityFileV1 = "startup.json";
export const executorIdentityFileRootV1 =
	"/var/run/agent-infra/executor-identity";
export const executorIdentityInputRootV1 =
	"/var/run/agent-infra/executor-projection";

function invalid(): never {
	throw new Error("CODEX_EXECUTOR_START_IDENTITY_INVALID");
}

function signingBytes(statement: Statement) {
	return Buffer.from(
		JSON.stringify([
			"agent-infra/codex-executor-start/v1",
			statement.podUid,
			statement.bindingDigest,
			statement.startupRef,
			statement.expiresAt,
			statement.role,
			statement.publicKey,
			statement.peerKey,
		]),
	);
}

function encodedPublicKey(key: KeyObject) {
	return key.export({ format: "der", type: "spki" }).toString("base64url");
}

/** Worker issues fresh keys for two recipients of one fenced startup. */
export function issueExecutorStartIdentityV1(
	start: Startup,
	issuerKey: KeyObject,
) {
	const binding = startSchema.parse(start);
	if (issuerKey.type !== "private" || issuerKey.asymmetricKeyType !== "ed25519")
		invalid();
	const host = generateKeyPairSync("ed25519");
	const runner = generateKeyPairSync("ed25519");
	const material = (
		role: Statement["role"],
		keys: typeof host,
		peer: typeof host,
	): Material => {
		const statement = {
			...binding,
			role,
			publicKey: encodedPublicKey(keys.publicKey),
			peerKey: encodedPublicKey(peer.publicKey),
		};
		return {
			statement,
			privateKey: keys.privateKey
				.export({ format: "der", type: "pkcs8" })
				.toString("base64url"),
			signature: sign(null, signingBytes(statement), issuerKey).toString(
				"base64url",
			),
		};
	};
	return {
		host: material("host", host, runner),
		runner: material("runner", runner, host),
	};
}

/** Local facts and the verification key come from independent deployment inputs. */
export function verifyExecutorStartIdentityV1(
	input: unknown,
	expected: Startup & {
		role: Statement["role"];
		now: number;
		issuerKey: KeyObject;
	},
) {
	try {
		const { statement, privateKey, signature } = materialSchema.parse(input);
		if (
			expected.issuerKey.type !== "public" ||
			expected.issuerKey.asymmetricKeyType !== "ed25519" ||
			!Number.isSafeInteger(expected.now) ||
			statement.role !== expected.role ||
			statement.podUid !== expected.podUid ||
			statement.bindingDigest !== expected.bindingDigest ||
			statement.startupRef !== expected.startupRef ||
			statement.expiresAt !== expected.expiresAt ||
			statement.expiresAt <= expected.now ||
			statement.peerKey === statement.publicKey ||
			!verify(
				null,
				signingBytes(statement),
				expected.issuerKey,
				Buffer.from(signature, "base64url"),
			)
		)
			return invalid();
		const key = createPrivateKey({
			key: Buffer.from(privateKey, "base64url"),
			format: "der",
			type: "pkcs8",
		});
		if (
			key.asymmetricKeyType !== "ed25519" ||
			encodedPublicKey(createPublicKey(key)) !== statement.publicKey
		)
			return invalid();
		return { ...statement, privateKey: key };
	} catch {
		return invalid();
	}
}
