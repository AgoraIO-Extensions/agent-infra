import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
} from "node:crypto";
import {
	ConnectionError,
	canonicalJson,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import postgres from "postgres";

type StoredCommand = {
	request_hash: string;
	response_ciphertext: string | null;
	response_nonce: string | null;
	response_tag: string | null;
	state: "COMPLETED" | "STARTED";
};

export type BrowserCommandInput = {
	idempotencyKey: string;
	operation: string;
	replayable?: boolean;
	request: unknown;
	subject: string;
};

export class PostgresBrowserCommandIdempotency {
	private readonly key: Buffer;
	private readonly sql;

	constructor(databaseUrl: string, key: Uint8Array) {
		if (key.byteLength !== 32) {
			throw new Error("Browser command encryption key must be 32 bytes");
		}
		this.key = Buffer.from(key);
		this.sql = postgres(databaseUrl, { max: 4 });
	}

	async execute<T>(input: BrowserCommandInput, command: () => Promise<T>) {
		const hashes = this.hashes(input);
		const inserted = await this.sql.begin(async (sql) => {
			const [created] = await sql<{ inserted: boolean }[]>`
				INSERT INTO connection_browser_command_idempotency (
					subject_scope_hash, operation, idempotency_key_hash,
					request_hash, state, expires_at
				) VALUES (
					${hashes.subjectScopeHash}, ${input.operation},
					${hashes.idempotencyKeyHash}, ${hashes.requestHash},
					'STARTED', 'infinity'::timestamptz
				)
				ON CONFLICT DO NOTHING
				RETURNING true AS inserted
			`;
			return Boolean(created?.inserted);
		});

		if (!inserted) return this.replay<T>(input, hashes);

		let result: T;
		try {
			result = await command();
		} catch (error) {
			if (this.isDefinitelyNoEffect(error)) {
				await this.sql`
					DELETE FROM connection_browser_command_idempotency
					WHERE subject_scope_hash = ${hashes.subjectScopeHash}
						AND operation = ${input.operation}
						AND idempotency_key_hash = ${hashes.idempotencyKeyHash}
						AND request_hash = ${hashes.requestHash}
						AND state = 'STARTED'
				`;
				throw error;
			}
			throw new ConnectionError(
				"RESULT_UNCERTAIN",
				"Browser command may have completed without an acknowledged response",
			);
		}

		const protectedResponse = this.protect(
			input.replayable === false
				? { replayable: false }
				: {
						hasValue: result !== undefined,
						replayable: true,
						value: result === undefined ? null : result,
					},
			this.associatedData(input, hashes),
		);
		const [completed] = await this.sql<{ completed: boolean }[]>`
			UPDATE connection_browser_command_idempotency
			SET state = 'COMPLETED',
				response_ciphertext = ${protectedResponse.ciphertext},
				response_nonce = ${protectedResponse.nonce},
				response_tag = ${protectedResponse.tag},
				completed_at = now()
			WHERE subject_scope_hash = ${hashes.subjectScopeHash}
				AND operation = ${input.operation}
				AND idempotency_key_hash = ${hashes.idempotencyKeyHash}
				AND request_hash = ${hashes.requestHash}
				AND state = 'STARTED'
			RETURNING true AS completed
		`;
		if (!completed?.completed) {
			throw new ConnectionError(
				"RESULT_UNCERTAIN",
				"Browser command completion is uncertain",
			);
		}
		return result;
	}

	async close() {
		await this.sql.end();
	}

	private hashes(input: BrowserCommandInput) {
		return {
			idempotencyKeyHash: this.hmac(`idempotency-key\0${input.idempotencyKey}`),
			requestHash: this.hmac(`request\0${canonicalJson(input.request)}`),
			subjectScopeHash: this.hmac(`subject\0${input.subject}`),
		};
	}

	private hmac(value: string) {
		return createHmac("sha256", this.key).update(value, "utf8").digest("hex");
	}

	private isDefinitelyNoEffect(error: unknown) {
		if (error instanceof OAuthProtocolError) return true;
		return (
			error instanceof ConnectionError &&
			[
				"AUTHENTICATION_FAILED",
				"FORBIDDEN",
				"IDEMPOTENCY_CONFLICT",
				"INVALID_REQUEST",
				"RESOURCE_NOT_FOUND",
			].includes(error.code)
		);
	}

	private associatedData(
		input: BrowserCommandInput,
		hashes: ReturnType<PostgresBrowserCommandIdempotency["hashes"]>,
	) {
		return Buffer.from(
			canonicalJson({
				idempotencyKeyHash: hashes.idempotencyKeyHash,
				operation: input.operation,
				requestHash: hashes.requestHash,
				subjectScopeHash: hashes.subjectScopeHash,
			}),
			"utf8",
		);
	}

	private protect(value: unknown, associatedData: Buffer) {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(associatedData);
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(value), "utf8"),
			cipher.final(),
		]);
		return {
			ciphertext: ciphertext.toString("base64url"),
			nonce: nonce.toString("base64url"),
			tag: cipher.getAuthTag().toString("base64url"),
		};
	}

	private async replay<T>(
		input: BrowserCommandInput,
		hashes: ReturnType<PostgresBrowserCommandIdempotency["hashes"]>,
	) {
		const [stored] = await this.sql<StoredCommand[]>`
			SELECT request_hash, state, response_ciphertext, response_nonce, response_tag
			FROM connection_browser_command_idempotency
			WHERE subject_scope_hash = ${hashes.subjectScopeHash}
				AND operation = ${input.operation}
				AND idempotency_key_hash = ${hashes.idempotencyKeyHash}
		`;
		if (!stored || stored.request_hash !== hashes.requestHash) {
			throw new ConnectionError(
				"IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different request",
			);
		}
		if (
			stored.state !== "COMPLETED" ||
			!stored.response_ciphertext ||
			!stored.response_nonce ||
			!stored.response_tag
		) {
			throw new ConnectionError(
				"RESULT_UNCERTAIN",
				"Browser command result is not safely replayable",
			);
		}
		const decoded = this.unprotect(stored, this.associatedData(input, hashes));
		if (!decoded.replayable) {
			throw new ConnectionError(
				"RESULT_UNCERTAIN",
				"Browser command completed but its secret response is not replayable",
			);
		}
		return (decoded.hasValue ? decoded.value : undefined) as T;
	}

	private unprotect(stored: StoredCommand, associatedData: Buffer) {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			this.key,
			Buffer.from(stored.response_nonce ?? "", "base64url"),
		);
		decipher.setAAD(associatedData);
		decipher.setAuthTag(Buffer.from(stored.response_tag ?? "", "base64url"));
		const plaintext = Buffer.concat([
			decipher.update(
				Buffer.from(stored.response_ciphertext ?? "", "base64url"),
			),
			decipher.final(),
		]).toString("utf8");
		return JSON.parse(plaintext) as
			| { replayable: false }
			| { hasValue: boolean; replayable: true; value: unknown };
	}
}
