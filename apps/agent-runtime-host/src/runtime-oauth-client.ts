import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	exchangeStandardOAuthCode,
	standardOAuthUnavailable as unavailable,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type RuntimeOAuthAuthorizedRequestV1,
	type RuntimeOAuthCallbackRequestV1,
	RuntimeOAuthCallbackRequestV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
	RuntimeOAuthGrantClaimsV1Schema,
	RuntimeOAuthOriginalExecutionRefV1Schema,
	type RuntimeOAuthResponseV1,
	RuntimeOAuthScopeV1Schema,
	RuntimePrincipalV1Schema,
	runtimeOAuthScopeV1,
} from "@agent-infra/contracts/runtime";
import type { createRuntimeOAuthGrantVerifier } from "./runtime-oauth-grant.js";
import {
	assertProtectedStandardMcpDirectoryCurrent,
	openProtectedStandardMcpDirectory,
	protectedStandardMcpPath,
	readProtectedStandardMcpBytes,
} from "./standard-mcp-files.js";
import { standardMcpInstallationKey } from "./standard-mcp-input.js";
import {
	ensurePrivateDirectory,
	publishMaterial,
} from "./standard-mcp-installation.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

interface Transaction {
	schemaVersion: 1;
	authorizationId: string;
	principal: { kind: "user"; id: string };
	scope: import("@agent-infra/contracts/runtime").RuntimeOAuthScopeV1;
	configuration: { ref: string; revision: string };
	configurationFingerprint: string;
	reference: import("@agent-infra/agent-runtime").RuntimeOriginalExecutionRef;
	state: string;
	phase: RuntimeOAuthResponseV1["phase"] | "exchange_started";
	expiresAt: number;
	requestDigest: string;
	tokenExpiresAt?: number;
}
function digest(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function parseTransaction(text: string): Transaction {
	const value = JSON.parse(text) as Transaction;
	const keys = [
		"schemaVersion",
		"authorizationId",
		"principal",
		"scope",
		"configuration",
		"configurationFingerprint",
		"reference",
		"state",
		"phase",
		"expiresAt",
		"requestDigest",
		...(value.tokenExpiresAt === undefined ? [] : ["tokenExpiresAt"]),
	]
		.sort()
		.join(",");
	if (
		!value ||
		Object.keys(value).sort().join(",") !== keys ||
		value.schemaVersion !== 1 ||
		!/^[a-f0-9]{64}$/.test(value.configurationFingerprint) ||
		!RuntimeOAuthOriginalExecutionRefV1Schema.safeParse(value.reference)
			.success ||
		!RuntimeOAuthGrantClaimsV1Schema.shape.authorizationId.safeParse(
			value.authorizationId,
		).success ||
		!RuntimePrincipalV1Schema.safeParse(value.principal).success ||
		value.principal.kind !== "user" ||
		!RuntimeOAuthScopeV1Schema.safeParse(value.scope).success ||
		!value.configuration ||
		Object.keys(value.configuration).sort().join(",") !== "ref,revision" ||
		!/^[A-Za-z0-9._:-]{1,128}$/.test(value.configuration.ref) ||
		!/^[A-Za-z0-9._:-]{1,128}$/.test(value.configuration.revision) ||
		!/^[a-f0-9]{64}$/.test(value.state) ||
		![
			"awaiting_callback",
			"awaiting_confirmation",
			"exchange_started",
			"awaiting_verification",
			"denied",
			"unknown",
		].includes(value.phase) ||
		!Number.isSafeInteger(value.expiresAt) ||
		value.expiresAt < 1 ||
		!/^[a-f0-9]{64}$/.test(value.requestDigest) ||
		(value.tokenExpiresAt !== undefined &&
			(!Number.isSafeInteger(value.tokenExpiresAt) || value.tokenExpiresAt < 1))
	)
		unavailable();
	return value;
}

async function writeRecord(path: string, name: string, value: unknown) {
	assertStandardMcpProcessProtection();
	const directory = await openProtectedStandardMcpDirectory(path);
	const temporary = `.stage-${randomUUID()}.json`;
	try {
		const file = await open(
			protectedStandardMcpPath(directory, path, temporary),
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			assertStandardMcpProcessProtection();
			await file.writeFile(JSON.stringify(value));
			assertStandardMcpProcessProtection();
			await file.sync();
			assertStandardMcpProcessProtection();
		} finally {
			await file.close();
		}
		await assertProtectedStandardMcpDirectoryCurrent(path, directory);
		await rename(
			protectedStandardMcpPath(directory, path, temporary),
			protectedStandardMcpPath(directory, path, name),
		);
		assertStandardMcpProcessProtection();
		await directory.sync();
		await assertProtectedStandardMcpDirectoryCurrent(path, directory);
	} finally {
		try {
			assertStandardMcpProcessProtection();
			await unlink(protectedStandardMcpPath(directory, path, temporary)).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				},
			);
		} finally {
			await directory.close();
		}
	}
}

export async function createProtectedRuntimeOAuthClient(options: {
	dataDirectory: string;
	configuration: RuntimeOAuthConfigurationV1;
	target: ApprovedConnectionConsumerTargetV1;
	scope: import("@agent-infra/contracts/runtime").RuntimeOAuthScopeV1;
	verifyGrant: ReturnType<typeof createRuntimeOAuthGrantVerifier>;
	store: Pick<
		import("@agent-infra/agent-runtime").FileRuntimeStore,
		"resolveOriginalExecutionBinding" | "assertOriginalExecutionBindingCurrent"
	>;
	fetch?: Parameters<typeof exchangeStandardOAuthCode>[0]["fetch"];
}) {
	const configuration = RuntimeOAuthConfigurationV1Schema.parse(
		options.configuration,
	);
	const configurationFingerprint = digest(configuration);
	const target = structuredClone(options.target);
	const scope = RuntimeOAuthScopeV1Schema.parse(options.scope);
	const root = join(
		options.dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
	);
	let path = options.dataDirectory;
	for (const part of [
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
		"records",
	]) {
		path = join(path, part);
		await ensurePrivateDirectory(path);
	}
	const records = join(root, "records");
	const materials = join(root, "materials");
	await ensurePrivateDirectory(materials);
	const abort = new AbortController();
	let closed = false;
	let queued = 0;
	let tail = Promise.resolve();
	const current = () => {
		assertStandardMcpProcessProtection();
		if (closed) unavailable();
	};
	// ponytail: one bounded OAuth I/O queue per Host; split by installation if login throughput requires it.
	function serial<T>(operation: () => Promise<T>) {
		current();
		if (queued >= 32) unavailable();
		queued++;
		const result = tail
			.then(async () => {
				current();
				return operation();
			})
			.finally(() => {
				queued--;
			});
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function read(name: string) {
		return readProtectedStandardMcpBytes(records, name, 16_384);
	}
	async function readOptionalMaterial(
		name: string,
		maximum: number,
		guard: () => void,
	) {
		try {
			return await readProtectedStandardMcpBytes(
				materials,
				name,
				maximum,
				guard,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async function load(key: string) {
		const record = parseTransaction(await read(`${key}.json`));
		current();
		if (
			!isDeepStrictEqual(record.scope, scope) ||
			record.configurationFingerprint !== configurationFingerprint ||
			!isDeepStrictEqual(record.configuration, {
				ref: configuration.ref,
				revision: configuration.revision,
			}) ||
			record.scope.configFingerprint !== target.configFingerprint ||
			!isDeepStrictEqual(record.scope.source, target.source)
		)
			unavailable();
		return record;
	}
	function response(record: Transaction): RuntimeOAuthResponseV1 {
		current();
		return {
			schemaVersion: 1,
			authorizationId: record.authorizationId,
			phase:
				record.phase === "exchange_started" || record.phase === "unknown"
					? "unknown"
					: record.expiresAt <= Date.now()
						? "expired"
						: record.phase,
			expiresAt: record.expiresAt,
		};
	}
	function keyFor(
		claims: import("@agent-infra/contracts/runtime").RuntimeOAuthGrantClaimsV1,
	) {
		return digest([
			standardMcpInstallationKey(claims.principal, claims.agentId, target),
			claims.authorizationId,
		]);
	}
	function check(
		request: RuntimeOAuthAuthorizedRequestV1,
		record?: Transaction,
	) {
		current();
		const claims = RuntimeOAuthGrantClaimsV1Schema.parse(
			options.verifyGrant(request),
		);
		if (
			record &&
			(claims.principal.kind !== record.principal.kind ||
				claims.principal.id !== record.principal.id ||
				!isDeepStrictEqual(runtimeOAuthScopeV1(claims), record.scope) ||
				!isDeepStrictEqual(request.reference, record.reference) ||
				claims.authorizationId !== record.authorizationId ||
				(request.command !== "status" && record.expiresAt <= Date.now()))
		)
			unavailable();
		options.store.assertOriginalExecutionBindingCurrent(
			request.reference,
			claims.principal,
			Date.now,
		);
		return claims;
	}
	async function original(
		reference: import("@agent-infra/agent-runtime").RuntimeOriginalExecutionRef,
		principal: Transaction["principal"],
	) {
		current();
		const binding = await options.store.resolveOriginalExecutionBinding(
			reference,
			Date.now,
		);
		current();
		if (
			!isDeepStrictEqual(binding.principal, principal) ||
			!isDeepStrictEqual(binding.scope, reference)
		)
			unavailable();
		options.store.assertOriginalExecutionBindingCurrent(
			reference,
			principal,
			Date.now,
		);
	}
	return {
		async authorized(request: RuntimeOAuthAuthorizedRequestV1) {
			const snapshot = structuredClone(request);
			return serial(async () => {
				const claims = check(snapshot);
				if (claims.principal.kind !== "user") unavailable();
				await original(snapshot.reference, {
					kind: "user",
					id: claims.principal.id,
				});
				check(snapshot);
				const key = keyFor(claims);
				if (snapshot.command === "begin") {
					let existing: Transaction | undefined;
					try {
						existing = await load(key);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					check(snapshot, existing);
					let record: Transaction;
					if (existing) {
						if (existing.requestDigest !== claims.requestDigest) unavailable();
						record = existing;
					} else {
						const installation = standardMcpInstallationKey(
							claims.principal,
							claims.agentId,
							target,
						);
						let pending: { key: string; expiresAt: number } | undefined;
						try {
							pending = JSON.parse(await read(`current-${installation}.json`));
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT")
								throw error;
						}
						check(snapshot);
						if (
							pending &&
							pending.expiresAt > Date.now() &&
							pending.key !== key
						)
							unavailable();
						const state = randomBytes(32).toString("hex");
						let verifier = await readOptionalMaterial(
							`${key}.verifier`,
							256,
							() => check(snapshot),
						);
						if (verifier !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(verifier))
							unavailable();
						if (verifier === undefined) {
							verifier = randomBytes(32).toString("base64url");
							await publishMaterial(
								materials,
								`${key}.verifier`,
								verifier,
								() => {
									check(snapshot);
								},
							);
						}
						record = {
							schemaVersion: 1,
							authorizationId: claims.authorizationId,
							principal: { kind: "user", id: claims.principal.id },
							scope: runtimeOAuthScopeV1(claims),
							configurationFingerprint,
							reference: snapshot.reference,
							configuration: {
								ref: configuration.ref,
								revision: configuration.revision,
							},
							state,
							phase: "awaiting_callback",
							expiresAt: Date.now() + 600_000,
							requestDigest: claims.requestDigest,
						};
						check(snapshot);
						await writeRecord(records, `${key}.json`, record);
						check(snapshot);
					}
					const result = response(record);
					if (result.phase === "awaiting_callback") {
						const installation = standardMcpInstallationKey(
							record.principal,
							record.scope.agentId,
							target,
						);
						let pending: { key: string; expiresAt: number } | undefined;
						try {
							pending = JSON.parse(await read(`current-${installation}.json`));
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT")
								throw error;
						}
						check(snapshot, record);
						if (
							pending &&
							pending.expiresAt > Date.now() &&
							pending.key !== key
						)
							unavailable();
						await publishMaterial(records, `state-${record.state}`, key);
						check(snapshot, record);
						await writeRecord(records, `current-${installation}.json`, {
							key,
							expiresAt: record.expiresAt,
						});
						check(snapshot, record);
						const verifier = await readProtectedStandardMcpBytes(
							materials,
							`${key}.verifier`,
							256,
							() => {
								check(snapshot, record);
							},
						);
						check(snapshot, record);
						const url = new URL(configuration.authorizationEndpoint);
						url.search = new URLSearchParams({
							response_type: "code",
							client_id: configuration.clientId,
							redirect_uri: configuration.callbackUrl,
							state: record.state,
							scope: configuration.scope,
							resource: configuration.resource,
							code_challenge_method: "S256",
							code_challenge: createHash("sha256")
								.update(verifier)
								.digest("base64url"),
						}).toString();
						result.authorizationUrl = url.toString();
					}
					check(snapshot, record);
					return result;
				}
				const record = await load(key);
				check(snapshot, record);
				if (snapshot.command === "status") return response(record);
				if (record.phase !== "awaiting_confirmation") return response(record);
				const code = await readProtectedStandardMcpBytes(
					materials,
					`${key}.code`,
					4096,
					() => {
						check(snapshot, record);
					},
				);
				check(snapshot, record);
				const verifier = await readProtectedStandardMcpBytes(
					materials,
					`${key}.verifier`,
					256,
					() => {
						check(snapshot, record);
					},
				);
				check(snapshot, record);
				record.phase = "exchange_started";
				await writeRecord(records, `${key}.json`, record);
				check(snapshot, record);
				try {
					const tokens = await exchangeStandardOAuthCode({
						configuration,
						code,
						verifier,
						signal: abort.signal,
						...(options.fetch ? { fetch: options.fetch } : {}),
						assertCurrent: () => {
							check(snapshot, record);
						},
					});
					check(snapshot, record);
					await publishMaterial(
						materials,
						`${key}.access`,
						tokens.accessToken,
						() => {
							check(snapshot, record);
						},
					);
					check(snapshot, record);
					if (tokens.refreshToken) {
						await publishMaterial(
							materials,
							`${key}.refresh`,
							tokens.refreshToken,
							() => {
								check(snapshot, record);
							},
						);
						check(snapshot, record);
					}
					record.phase = "awaiting_verification";
					record.tokenExpiresAt = tokens.expiresAt;
					await writeRecord(records, `${key}.json`, record);
					check(snapshot, record);
				} catch {
					record.phase = "unknown";
					await writeRecord(records, `${key}.json`, record).catch(
						() => undefined,
					);
				}
				return response(record);
			});
		},
		async callback(input: RuntimeOAuthCallbackRequestV1) {
			const request = RuntimeOAuthCallbackRequestV1Schema.parse(
				structuredClone(input),
			);
			return serial(async () => {
				if (request.issuer !== configuration.issuer) unavailable();
				const key = await read(`state-${request.state}`);
				current();
				if (!/^[a-f0-9]{64}$/.test(key)) unavailable();
				const record = await load(key);
				if (
					record.state !== request.state ||
					record.phase !== "awaiting_callback" ||
					record.expiresAt <= Date.now()
				)
					unavailable();
				await original(record.reference, record.principal);
				const assertOriginal = () => {
					current();
					options.store.assertOriginalExecutionBindingCurrent(
						record.reference,
						record.principal,
						Date.now,
					);
				};
				assertOriginal();
				if (request.code) {
					await publishMaterial(
						materials,
						`${key}.code`,
						request.code,
						assertOriginal,
					);
					assertOriginal();
					record.phase = "awaiting_confirmation";
				} else record.phase = "denied";
				await writeRecord(records, `${key}.json`, record);
				assertOriginal();
				return response(record);
			});
		},
		async close() {
			closed = true;
			abort.abort();
			await tail;
		},
	};
}
export type ProtectedRuntimeOAuthClient = Awaited<
	ReturnType<typeof createProtectedRuntimeOAuthClient>
>;
