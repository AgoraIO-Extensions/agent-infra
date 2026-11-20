import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import {
	type ExecutorInstanceStartV2,
	ExecutorInstanceStartV2Schema,
	executorInstanceFactBytesV2,
} from "@agent-infra/contracts/runtime";
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
const v2StatementSchema = ExecutorInstanceStartV2Schema.extend({
	role: z.enum(["host", "runner"]),
	publicKey: encoded,
	peerKey: encoded,
	issuerKeyId: z.string().regex(/^[a-f0-9]{64}$/),
	factDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const anyStatementSchema = z.union([statementSchema, v2StatementSchema]);
const materialSchema = z.strictObject({
	statement: anyStatementSchema,
	privateKey: encoded,
	signature: encoded,
});
export type ExecutorStartupBindingV1 = z.infer<typeof startSchema>;
type Startup = ExecutorStartupBindingV1 | ExecutorInstanceStartV2;
type Statement = z.infer<typeof anyStatementSchema>;
type Material = z.infer<typeof materialSchema>;
export type ExecutorIdentityV1 = Statement & { privateKey: KeyObject };
const verifiedIdentities = new WeakSet<object>();
export function verifiedExecutorInstanceIdentityV2(
	identity: ExecutorIdentityV1,
) {
	if (
		!verifiedIdentities.has(identity) ||
		!("schemaVersion" in identity) ||
		identity.schemaVersion !== 2
	)
		return invalid();
	return identity;
}

export const executorIdentityFileV1 = "startup.json";
export const executorIdentityFileRootV1 =
	"/var/run/agent-infra/executor-identity";
export const executorIdentityInputRootV1 =
	"/var/run/agent-infra/executor-projection";

function invalid(): never {
	throw new Error("CODEX_EXECUTOR_START_IDENTITY_INVALID");
}

function signingBytes(statement: Statement) {
	if ("schemaVersion" in statement)
		return Buffer.from(
			JSON.stringify([
				"executor-instance-startup-v2",
				executorInstanceFactBytesV2(statement),
				statement.factDigest,
				statement.issuerKeyId,
				statement.role,
				statement.publicKey,
				statement.peerKey,
			]),
		);
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
	const binding =
		"schemaVersion" in start
			? ExecutorInstanceStartV2Schema.parse(start)
			: startSchema.parse(start);
	if (issuerKey.type !== "private" || issuerKey.asymmetricKeyType !== "ed25519")
		invalid();
	const host = generateKeyPairSync("ed25519");
	const runner = generateKeyPairSync("ed25519");
	const material = (
		role: Statement["role"],
		keys: typeof host,
		peer: typeof host,
	): Material => {
		const statement: Statement = {
			...binding,
			...("schemaVersion" in binding
				? {
						issuerKeyId: createHash("sha256")
							.update(encodedPublicKey(createPublicKey(issuerKey)))
							.digest("hex"),
						factDigest: createHash("sha256")
							.update(
								executorInstanceFactBytesV2(
									ExecutorInstanceStartV2Schema.parse(binding),
								),
							)
							.digest("hex"),
					}
				: {}),
			role,
			publicKey: encodedPublicKey(keys.publicKey),
			peerKey: encodedPublicKey(peer.publicKey),
		};
		return {
			statement,
			privateKey: keys.privateKey
				.export({ format: "der", type: "pkcs8" })
				.toString("base64url"),
			signature: sign(
				null,
				signingBytes(anyStatementSchema.parse(statement)),
				issuerKey,
			).toString("base64url"),
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
		instanceBinding?: {
			sandboxId: string;
			generation: number;
			resourceFence: number;
		};
	},
) {
	try {
		const { statement, privateKey, signature } = materialSchema.parse(input);
		if ("schemaVersion" in expected && !("schemaVersion" in statement))
			return invalid();
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
		if ("schemaVersion" in statement) {
			if (
				("schemaVersion" in expected
					? expected.schemaVersion !== 2 ||
						executorInstanceFactBytesV2(statement) !==
							executorInstanceFactBytesV2(
								ExecutorInstanceStartV2Schema.strip().parse(expected),
							)
					: !expected.instanceBinding ||
						expected.instanceBinding.sandboxId !==
							statement.instance.sandboxId ||
						expected.instanceBinding.generation !==
							statement.instance.generation ||
						expected.instanceBinding.resourceFence !==
							statement.instance.resourceFence) ||
				statement.factDigest !==
					createHash("sha256")
						.update(executorInstanceFactBytesV2(statement))
						.digest("hex") ||
				statement.issuerKeyId !==
					createHash("sha256")
						.update(encodedPublicKey(expected.issuerKey))
						.digest("hex")
			)
				return invalid();
		}
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
		if ("instance" in statement) Object.freeze(statement.instance);
		const identity = Object.freeze({ ...statement, privateKey: key });
		verifiedIdentities.add(identity);
		return identity;
	} catch {
		return invalid();
	}
}
