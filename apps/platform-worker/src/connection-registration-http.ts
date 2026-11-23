import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	type ConnectionConsumerDisableDeliveryV1,
	type ConnectionConsumerDisableIntentV1,
	type ConnectionConsumerRegistrationDeliveryV1,
	type ConnectionConsumerRegistrationIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegistrationPolicyV1,
	parseConnectionConsumerDisableIntentV1,
	parseConnectionConsumerRegistrationIntentV1,
} from "@agent-infra/platform-core";
import {
	type ConnectionConsumerRegistrationAdapterV1,
	type ConnectionRegistrationCredentialSinkV2,
	connectionConsumerDisableNotSentV1,
} from "./connection-registration-worker.js";

export interface ConnectionRegistrationOwnerBindingV1 {
	readonly sourceNamespace: string;
	readonly platformAgentId: string;
	readonly platformOwnerId: string;
	readonly ownerPrincipalId: string;
	readonly companyId: string;
}

export interface ConnectionRegistrationHttpOptionsV1 {
	readonly publicOrigin: string;
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	/** Approved D1 transport: execute this Request once, honor abort/redirect, and never use Cookie/user/Consumer credentials. */
	readonly authenticatedRequest?: (request: Request) => Promise<Response>;
	/** Existing trusted D2 mapping; a Platform user ID is never a Connection Principal. */
	readonly resolveOwnerBinding?: (
		intent: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
	) => Promise<ConnectionRegistrationOwnerBindingV1 | undefined>;
}

const component = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const receiptKeys = [
	"schemaVersion",
	"registrationId",
	"sourceReceipt",
	"sourceNamespace",
	"platformAgentId",
	"consumerId",
	"executionMode",
	"ownerPrincipalId",
	"companyId",
	"consumerName",
	"callbackUrl",
	"resource",
	"scopes",
	"policyRevision",
	"status",
	"revision",
	"requestKeyHash",
	"requestDigestVersion",
	"requestDigest",
];
const operationKeys = [
	"schemaVersion",
	"kind",
	"sourceNamespace",
	"platformAgentId",
	"consumerId",
	"registrationId",
	"requestKeyHash",
	"requestDigestVersion",
	"requestDigest",
	"expectedRevision",
	"resultRevision",
	"status",
	"failureCode",
];
const unknown = (): ConnectionConsumerRegistrationDeliveryV1 => ({
	outcome: "unknown",
	failureCode: "CONNECTION_REGISTRATION_UNCONFIRMED",
});
const disableUnknown = (): ConnectionConsumerDisableDeliveryV1 => ({
	outcome: "unknown",
	failureCode: "CONNECTION_DISABLE_UNCONFIRMED",
});
const invalid = () => new Error("CONNECTION_REGISTRATION_RESPONSE_INVALID");

function exact(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw invalid();
	const value = input as Record<string, unknown>;
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some(
			(key) => !required.includes(key) && !optional.includes(key),
		)
	)
		throw invalid();
	return value;
}

function reference(input: unknown): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		Buffer.byteLength(input, "utf8") <= 1024 &&
		input.isWellFormed() &&
		input.normalize("NFC") === input &&
		!/[\p{Cc}]/u.test(input) &&
		!/^conn_(?:consumer|pat|service)_/.test(input)
	);
}

function revision(input: unknown): input is string {
	return (
		typeof input === "string" &&
		/^[1-9][0-9]{0,18}$/.test(input) &&
		BigInt(input) <= 9223372036854775807n
	);
}

function hash(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function remoteDigest(
	intent: ConnectionConsumerRegistrationIntentV1,
	name: string,
	scopes: readonly string[],
	owner: ConnectionRegistrationOwnerBindingV1,
	version: 1 | 2,
) {
	// Fixed ASCII keys are in canonical scalar order; every string is already NFC.
	const json = JSON.stringify({
		callbackUrl: intent.callbackUrl,
		consumerName: name,
		executionMode: "USER",
		owner: { companyId: owner.companyId, principalId: owner.ownerPrincipalId },
		platformAgentId: intent.platformAgentId,
		policyRevision: intent.policyRevision,
		resource: intent.resource,
		schemaVersion: version,
		scopes: [...scopes].sort(),
		sourceNamespace: intent.sourceNamespace,
		version: `platform-agent-consumer-v${version}`,
	});
	return `connection-json-v2:${hash(`connection-json-v2:${json}`)}`;
}

/** Connection lifecycle digest (registration Spec §4); keys are in canonical ASCII order. */
function lifecycleDigest(
	intent: ConnectionConsumerDisableIntentV1,
	version: 1 | 2,
) {
	const json = JSON.stringify({
		consumerId: intent.consumerId.normalize("NFC"),
		expectedRevision: intent.expectedRevision,
		kind: "disable",
		platformAgentId: intent.platformAgentId,
		policyRevision: intent.policyRevision,
		schemaVersion: version,
		sourceNamespace: intent.sourceNamespace,
		version: `platform-agent-consumer-lifecycle-v${version}`,
	});
	return `connection-json-v2:${hash(`connection-json-v2:${json}`)}`;
}

async function readJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (
		response.headers
			.get("content-type")
			?.split(";")[0]
			?.trim()
			.toLowerCase() !== "application/json" ||
		!response.headers
			.get("cache-control")
			?.split(",")
			.some((part) => part.trim().toLowerCase() === "no-store") ||
		!response.body
	) {
		void response.body?.cancel().catch(() => {});
		throw invalid();
	}
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let length = 0;
	let complete = false;
	try {
		while (true) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) {
				complete = true;
				break;
			}
			length += next.value.byteLength;
			if (length > 64 * 1024) throw invalid();
			chunks.push(next.value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	} finally {
		signal.removeEventListener("abort", cancel);
		if (!complete) cancel();
		reader.releaseLock();
	}
}

/** Supplies only the existing register/reconcile/disable seam; no production route is enabled here. */
export function createConnectionConsumerRegistrationHttpAdapterV1(
	options: ConnectionRegistrationHttpOptionsV1,
): ConnectionConsumerRegistrationAdapterV1 | undefined {
	return createHttpAdapter(options, 1);
}

/** EP-1146: explicitly opt into the one-time response credential contract. */
export function createConnectionConsumerRegistrationHttpAdapterV2(
	options: ConnectionRegistrationHttpOptionsV1,
): ConnectionConsumerRegistrationAdapterV1 | undefined {
	return createHttpAdapter(options, 2);
}

function createHttpAdapter(
	options: ConnectionRegistrationHttpOptionsV1,
	version: 1 | 2,
): ConnectionConsumerRegistrationAdapterV1 | undefined {
	const digestVersion = `platform-agent-consumer-v${version}/connection-json-v2`;
	const lifecycleDigestVersion = `platform-agent-consumer-lifecycle-v${version}/connection-json-v2`;
	if (
		typeof options.authenticatedRequest !== "function" ||
		typeof options.resolveOwnerBinding !== "function"
	)
		return undefined;
	const request = options.authenticatedRequest;
	const resolveOwner = options.resolveOwnerBinding;
	let origin: URL;
	try {
		origin = new URL(options.publicOrigin);
	} catch {
		throw new Error("CONNECTION_REGISTRATION_CONFIGURATION_INVALID");
	}
	if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin)
		throw new Error("CONNECTION_REGISTRATION_CONFIGURATION_INVALID");
	const policy = captureConnectionConsumerRegistrationPolicyV1(options.policy);
	if (new URL(policy.resource).origin !== origin.origin)
		throw new Error("CONNECTION_REGISTRATION_CONFIGURATION_INVALID");

	async function execute(
		input: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
		mode: "register" | "reconcile",
		retainCredential?: ConnectionRegistrationCredentialSinkV2,
	): Promise<ConnectionConsumerRegistrationDeliveryV1> {
		let requested = false;
		try {
			signal.throwIfAborted();
			if (version === 2 && !retainCredential) return unknown();
			const intent = parseConnectionConsumerRegistrationIntentV1(input);
			if (
				intent.sourceNamespace !== policy.sourceNamespace ||
				intent.policyRevision !== policy.revision ||
				intent.callbackUrl !== policy.callbackUrl ||
				intent.resource !== policy.resource ||
				intent.scope !== policy.scope ||
				!component.test(intent.platformAgentId)
			)
				throw invalid();
			const name = intent.consumerName.normalize("NFC");
			if (
				!name.trim() ||
				[...name].length > 200 ||
				Buffer.byteLength(name, "utf8") > 800
			)
				throw invalid();
			const scopes = intent.scope.split(" ");
			const keyHash = hash(intent.idempotencyKey);
			const root = `${origin.origin}/connection/internal/v${version}/platform-agent-consumer-registrations/${encodeURIComponent(intent.sourceNamespace)}/${encodeURIComponent(intent.platformAgentId)}`;
			const body = JSON.stringify({
				schemaVersion: version,
				policyRevision: intent.policyRevision,
				consumerName: name,
				callbackUrl: intent.callbackUrl,
				resource: intent.resource,
				scopes,
			});
			if (Buffer.byteLength(body, "utf8") > 8192) throw invalid();
			const target =
				mode === "register" ? root : `${root}/operations/create/${keyHash}`;
			const headers: Record<string, string> = { accept: "application/json" };
			if (mode === "register") {
				headers["content-type"] = "application/json";
				headers["idempotency-key"] = intent.idempotencyKey;
			}
			const httpRequest = new Request(target, {
				method: mode === "register" ? "POST" : "GET",
				headers,
				...(mode === "register" ? { body } : {}),
				credentials: "omit",
				redirect: "error",
				signal,
			});
			requested = true;
			const response = await request(httpRequest);
			if (signal.aborted) {
				void response.body?.cancel().catch(() => {});
				return unknown();
			}
			if (
				response.redirected ||
				(response.url && response.url !== target) ||
				!(
					version === 2
						? mode === "register"
							? [200, 201]
							: [200]
						: [200, 202]
				).includes(response.status)
			) {
				void response.body?.cancel().catch(() => {});
				return unknown();
			}
			const value = exact(await readJson(response, signal), [
				"receipt",
				"operation",
				...(version === 2 && response.status === 201 ? ["secret"] : []),
			]);
			const receipt = exact(value.receipt, receiptKeys, [
				...(version === 1 ? ["protectedHandoffRef"] : []),
			]);
			const operation = exact(value.operation, operationKeys);
			const owner = await resolveOwner(intent, signal);
			signal.throwIfAborted();
			if (
				!owner ||
				owner.sourceNamespace !== intent.sourceNamespace ||
				owner.platformAgentId !== intent.platformAgentId ||
				owner.platformOwnerId !== intent.platformOwnerId ||
				!reference(owner.ownerPrincipalId) ||
				!reference(owner.companyId)
			)
				throw invalid();
			const digest = remoteDigest(intent, name, scopes, owner, version);
			if (
				receipt.schemaVersion !== version ||
				receipt.sourceNamespace !== intent.sourceNamespace ||
				receipt.platformAgentId !== intent.platformAgentId ||
				receipt.executionMode !== "USER" ||
				receipt.ownerPrincipalId !== owner.ownerPrincipalId ||
				receipt.companyId !== owner.companyId ||
				receipt.consumerName !== name ||
				receipt.callbackUrl !== intent.callbackUrl ||
				receipt.resource !== intent.resource ||
				receipt.policyRevision !== intent.policyRevision ||
				!Array.isArray(receipt.scopes) ||
				receipt.scopes.length !== scopes.length ||
				new Set(receipt.scopes).size !== scopes.length ||
				receipt.scopes.some(
					(scope) => typeof scope !== "string" || !scopes.includes(scope),
				) ||
				!reference(receipt.consumerId) ||
				!reference(receipt.registrationId) ||
				!reference(receipt.sourceReceipt) ||
				!revision(receipt.revision) ||
				receipt.requestKeyHash !== keyHash ||
				receipt.requestDigestVersion !== digestVersion ||
				receipt.requestDigest !== digest ||
				!["PENDING", "ACTIVE", "DISABLED", "DELETED", "UNKNOWN"].includes(
					String(receipt.status),
				) ||
				(Object.hasOwn(receipt, "protectedHandoffRef") &&
					(typeof receipt.protectedHandoffRef !== "string" ||
						!/^handoff_[A-Za-z0-9_-]{32,128}$/.test(
							receipt.protectedHandoffRef,
						)))
			)
				throw invalid();
			if (
				operation.schemaVersion !== version ||
				operation.kind !== "create" ||
				operation.sourceNamespace !== receipt.sourceNamespace ||
				operation.platformAgentId !== receipt.platformAgentId ||
				operation.consumerId !== receipt.consumerId ||
				operation.registrationId !== receipt.registrationId ||
				operation.requestKeyHash !== keyHash ||
				operation.requestDigestVersion !== digestVersion ||
				operation.requestDigest !== digest ||
				operation.expectedRevision !== null ||
				!["PENDING", "UNKNOWN", "APPLIED", "FAILED"].includes(
					String(operation.status),
				) ||
				(operation.status === "FAILED"
					? typeof operation.failureCode !== "string" ||
						!/^[A-Z][A-Z0-9_]{0,63}$/.test(operation.failureCode)
					: operation.failureCode !== null) ||
				(operation.status === "APPLIED"
					? operation.resultRevision !== receipt.revision
					: operation.resultRevision !== null)
			)
				throw invalid();
			if (version === 1 && response.status !== 200) return unknown();
			if (
				version === 2 &&
				response.status === 201 &&
				operation.status !== "APPLIED"
			)
				return unknown();
			if (operation.status === "FAILED")
				return {
					outcome: "failed",
					failureCode: "CONNECTION_REGISTRATION_REJECTED",
				};
			if (
				(version === 1 && response.status !== 200) ||
				operation.status !== "APPLIED" ||
				receipt.status !== "ACTIVE"
			)
				return unknown();
			const delivery = {
				outcome: "registered" as const,
				receipt: {
					schemaVersion: 1 as const,
					operationId: intent.operationId,
					sourceNamespace: intent.sourceNamespace,
					sourceKey: intent.sourceKey,
					consumerId: receipt.consumerId,
					consumerRevision: receipt.revision,
					registrationId: receipt.registrationId,
					requestDigest: intent.requestDigest,
				},
			};
			if (version === 2) {
				let credential: Uint8Array | undefined;
				try {
					if (response.status === 201) {
						if (
							typeof value.secret !== "string" ||
							!/^conn_consumer_[A-Za-z0-9_-]{32,128}$/.test(value.secret)
						)
							throw invalid();
						credential = Buffer.from(value.secret, "utf8");
						delete value.secret;
					}
					if (!(await retainCredential?.(delivery, credential)))
						return unknown();
					signal.throwIfAborted();
				} finally {
					credential?.fill(0);
				}
			}
			return delivery;
		} catch {
			if (!requested && mode === "register" && !signal.aborted)
				return {
					outcome: "failed",
					failureCode: "CONNECTION_REGISTRATION_REQUEST_INVALID",
				};
			return unknown();
		}
	}
	/** `POST R/disable` once; unknown results only read back `GET R/operations/disable/{hash}`. */
	async function lifecycle(
		input: ConnectionConsumerDisableIntentV1,
		signal: AbortSignal,
		mode: "disable" | "reconcile",
	): Promise<ConnectionConsumerDisableDeliveryV1> {
		let requested = false;
		try {
			signal.throwIfAborted();
			const intent = parseConnectionConsumerDisableIntentV1(input);
			// Connection checks the POST body against its current policy; a readback is not revalidated.
			if (
				intent.sourceNamespace !== policy.sourceNamespace ||
				(mode === "disable" && intent.policyRevision !== policy.revision) ||
				!component.test(intent.platformAgentId)
			)
				throw invalid();
			const keyHash = hash(intent.idempotencyKey);
			const digest = lifecycleDigest(intent, version);
			const root = `${origin.origin}/connection/internal/v${version}/platform-agent-consumer-registrations/${encodeURIComponent(intent.sourceNamespace)}/${encodeURIComponent(intent.platformAgentId)}`;
			const target =
				mode === "disable"
					? `${root}/disable`
					: `${root}/operations/disable/${keyHash}`;
			const headers: Record<string, string> = { accept: "application/json" };
			if (mode === "disable") {
				headers["content-type"] = "application/json";
				headers["idempotency-key"] = intent.idempotencyKey;
			}
			const httpRequest = new Request(target, {
				method: mode === "disable" ? "POST" : "GET",
				headers,
				...(mode === "disable"
					? {
							body: JSON.stringify({
								schemaVersion: version,
								policyRevision: intent.policyRevision,
								revision: intent.expectedRevision,
							}),
						}
					: {}),
				credentials: "omit",
				redirect: "error",
				signal,
			});
			requested = true;
			const response = await request(httpRequest);
			if (
				signal.aborted ||
				response.redirected ||
				(response.url && response.url !== target) ||
				response.status !== 200
			) {
				// 202, error envelopes and transport surprises cannot be bound to the original command.
				void response.body?.cancel().catch(() => {});
				return disableUnknown();
			}
			const value = exact(await readJson(response, signal), [
				"receipt",
				"operation",
			]);
			const receipt = exact(value.receipt, receiptKeys, [
				...(version === 1 ? ["protectedHandoffRef"] : []),
			]);
			const operation = exact(value.operation, operationKeys);
			if (
				receipt.schemaVersion !== version ||
				receipt.sourceNamespace !== intent.sourceNamespace ||
				receipt.platformAgentId !== intent.platformAgentId ||
				receipt.consumerId !== intent.consumerId ||
				receipt.registrationId !== intent.registrationId ||
				receipt.executionMode !== "USER" ||
				receipt.requestKeyHash !== intent.registrationKeyHash ||
				receipt.requestDigestVersion !== digestVersion ||
				typeof receipt.requestDigest !== "string" ||
				!/^connection-json-v2:[a-f0-9]{64}$/.test(receipt.requestDigest) ||
				!revision(receipt.revision) ||
				!["PENDING", "ACTIVE", "DISABLED", "DELETED", "UNKNOWN"].includes(
					String(receipt.status),
				)
			)
				throw invalid();
			if (
				operation.schemaVersion !== version ||
				operation.kind !== "disable" ||
				operation.sourceNamespace !== intent.sourceNamespace ||
				operation.platformAgentId !== intent.platformAgentId ||
				operation.consumerId !== intent.consumerId ||
				operation.registrationId !== intent.registrationId ||
				operation.requestKeyHash !== keyHash ||
				operation.requestDigestVersion !== lifecycleDigestVersion ||
				operation.requestDigest !== digest ||
				operation.expectedRevision !== intent.expectedRevision ||
				!["PENDING", "UNKNOWN", "APPLIED", "FAILED"].includes(
					String(operation.status),
				) ||
				(operation.status === "FAILED"
					? typeof operation.failureCode !== "string" ||
						!/^[A-Z][A-Z0-9_]{0,63}$/.test(operation.failureCode)
					: operation.failureCode !== null) ||
				(operation.status === "APPLIED"
					? !revision(operation.resultRevision) ||
						BigInt(operation.resultRevision) <=
							BigInt(intent.expectedRevision) ||
						BigInt(operation.resultRevision) >
							BigInt(receipt.revision as string)
					: operation.resultRevision !== null)
			)
				throw invalid();
			if (operation.status === "FAILED")
				return {
					outcome: "failed",
					failureCode: "CONNECTION_DISABLE_REJECTED",
				};
			if (operation.status !== "APPLIED") return disableUnknown();
			return {
				outcome: "disabled",
				receipt: {
					schemaVersion: 1,
					operationId: intent.operationId,
					consumerId: intent.consumerId,
					registrationId: intent.registrationId,
					resultRevision: operation.resultRevision as string,
					requestDigest: intent.requestDigest,
				},
			};
		} catch {
			// Only a POST that was certainly never started may return to the unsent state.
			if (!requested && mode === "disable" && !signal.aborted)
				throw new Error(connectionConsumerDisableNotSentV1);
			return disableUnknown();
		}
	}
	return {
		...(version === 2 ? { credentialDelivery: "RESPONSE" as const } : {}),
		register: (intent, signal, retain) =>
			execute(intent, signal, "register", retain),
		reconcile: (intent, signal, retain) =>
			execute(intent, signal, "reconcile", retain),
		disable: (intent, signal) => lifecycle(intent, signal, "disable"),
		reconcileDisable: (intent, signal) =>
			lifecycle(intent, signal, "reconcile"),
	};
}
