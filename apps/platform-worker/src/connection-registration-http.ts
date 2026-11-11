import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	type ConnectionConsumerRegistrationDeliveryV1,
	type ConnectionConsumerRegistrationIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegistrationPolicyV1,
	parseConnectionConsumerRegistrationIntentV1,
} from "@agent-infra/platform-core";
import type { ConnectionConsumerRegistrationAdapterV1 } from "./connection-registration-worker.js";

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

const digestVersion = "platform-agent-consumer-v1/connection-json-v2";
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
		schemaVersion: 1,
		scopes: [...scopes].sort(),
		sourceNamespace: intent.sourceNamespace,
		version: "platform-agent-consumer-v1",
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

/** Supplies only the existing register/reconcile seam; no production route is enabled here. */
export function createConnectionConsumerRegistrationHttpAdapterV1(
	options: ConnectionRegistrationHttpOptionsV1,
): ConnectionConsumerRegistrationAdapterV1 | undefined {
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
	): Promise<ConnectionConsumerRegistrationDeliveryV1> {
		let requested = false;
		try {
			signal.throwIfAborted();
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
			const root = `${origin.origin}/connection/internal/v1/platform-agent-consumer-registrations/${encodeURIComponent(intent.sourceNamespace)}/${encodeURIComponent(intent.platformAgentId)}`;
			const body = JSON.stringify({
				schemaVersion: 1,
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
				![200, 202].includes(response.status)
			) {
				void response.body?.cancel().catch(() => {});
				return unknown();
			}
			const value = exact(await readJson(response, signal), [
				"receipt",
				"operation",
			]);
			const receipt = exact(value.receipt, receiptKeys, [
				"protectedHandoffRef",
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
			const digest = remoteDigest(intent, name, scopes, owner);
			if (
				receipt.schemaVersion !== 1 ||
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
				operation.schemaVersion !== 1 ||
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
			if (response.status !== 200) return unknown();
			if (operation.status === "FAILED")
				return {
					outcome: "failed",
					failureCode: "CONNECTION_REGISTRATION_REJECTED",
				};
			if (
				response.status !== 200 ||
				operation.status !== "APPLIED" ||
				receipt.status !== "ACTIVE"
			)
				return unknown();
			return {
				outcome: "registered",
				receipt: {
					schemaVersion: 1,
					operationId: intent.operationId,
					sourceNamespace: intent.sourceNamespace,
					sourceKey: intent.sourceKey,
					consumerId: receipt.consumerId,
					consumerRevision: receipt.revision,
					registrationId: receipt.registrationId,
					requestDigest: intent.requestDigest,
				},
			};
		} catch {
			if (!requested && mode === "register" && !signal.aborted)
				return {
					outcome: "failed",
					failureCode: "CONNECTION_REGISTRATION_REQUEST_INVALID",
				};
			return unknown();
		}
	}
	return {
		register: (intent, signal) => execute(intent, signal, "register"),
		reconcile: (intent, signal) => execute(intent, signal, "reconcile"),
	};
}
