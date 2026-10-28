import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotObject } from "./conversation-execution-values.js";
import type { FileDescriptorV1, StoredFileObjectV1 } from "./file-authority.js";
import {
	parseTaskPrincipalV1,
	type TaskPrincipalV1,
} from "./task-authorization.js";

export const evaluationAuditActionsV1 = [
	"evaluation.dataset.list",
	"evaluation.dataset.create",
	"evaluation.version.reserve",
	"evaluation.grant.create",
	"evaluation.grant.revoke",
	"evaluation.content.write",
	"evaluation.content.confirm",
	"evaluation.content.read",
	"evaluation.content.delete",
	"evaluation.experiment.create",
	"evaluation.experiment.cancel",
	"evaluation.derived.confirm",
	"evaluation.score.completed",
	"evaluation.score.human",
	"evaluation.score.reviewed",
] as const;
export const evaluationOperationsV1 = [
	"create",
	"import",
	"read",
	"run",
	"score",
	"review",
	"analyze",
	"manage_grants",
	"delete",
] as const;
export type EvaluationOperationV1 = (typeof evaluationOperationsV1)[number];
export type EvaluationPrincipalV1 = TaskPrincipalV1;
export type EvaluationAuthenticationV1 =
	| { kind: "browser"; userId: string }
	| { kind: "credential"; material: string }
	| {
			kind: "score_work";
			intentId: string;
			leaseOwner: string;
			deliveryFence: string;
	  };
export interface EvaluationRequestV1 {
	authentication: EvaluationAuthenticationV1;
	requestId: string;
	traceId: string;
	/** Fixed by server-only experiment/scoring use cases, never decoded from HTTP. */
	credentialScope?: "eval:run" | "eval:score" | "eval:review";
}
/** The bounded V1 metadata projection must be explicitly approved as a whole. */
export const evaluationRetainedMetadataFieldsV1 = [
	"datasetId",
	"scope",
	"name",
	"revision",
	"createdAt",
	"metadataExpiresAt",
	"versionId",
	"sourceVersionId",
	"status",
	"expiresAt",
	"deleteBy",
	"policyId",
	"policyRevision",
	"objectRef",
	"materialApprovalId",
	"grantId",
	"versionIds",
	"principal",
	"operations",
	"revoked",
	"issuer",
	"idempotencyDigest",
] as const;
export interface EvaluationPolicyV1 {
	schemaVersion: 1;
	policyId: string;
	revision: number;
	validUntil: string;
	retainedMetadataFields: readonly string[];
	materialApprovals: readonly {
		approvalId: string;
		scope: string;
		kind: "synthetic" | "approved";
		redactionRef: string | null;
	}[];
	managers: readonly {
		principal: EvaluationPrincipalV1;
		scopes: readonly string[];
		operations: readonly EvaluationOperationV1[];
		maxGrantMs: number;
	}[];
	retention: Record<
		"samples" | "rubric" | "output" | "score" | "review",
		{
			startsAt: "version_reserved" | "content_created";
			contentMs: number;
			metadataMs: number;
			deleteWithinMs: number;
		}
	>;
	maxContentBytes: number;
	transferTimeoutMs: number;
	pendingMs: number;
}
export interface EvaluationDatasetV1 {
	datasetId: string;
	scope: string;
	name: string;
	revision: number;
	createdAt: string;
	metadataExpiresAt: string;
}
export interface EvaluationVersionV1 {
	versionId: string;
	datasetId: string;
	sourceVersionId: string | null;
	revision: number;
	status: "pending" | "uploading" | "available" | "deleting" | "deleted";
	createdAt: string;
	expiresAt: string;
	metadataExpiresAt: string;
	deleteBy: string;
	policyId: string;
	policyRevision: number;
	objectRef: string;
	materialApprovalId: string | null;
	descriptor: FileDescriptorV1 | null;
	stored: StoredFileObjectV1 | null;
	uploadActor: EvaluationPrincipalV1 | null;
	uploadGrantId: string | null;
	uploadGrantRevision: number | null;
	transferUntil: string | null;
}
export interface EvaluationGrantV1 {
	grantId: string;
	datasetId: string;
	versionIds: readonly string[];
	principal: EvaluationPrincipalV1;
	operations: readonly EvaluationOperationV1[];
	expiresAt: string;
	revision: number;
	revoked: boolean;
	issuer: EvaluationPrincipalV1;
	policyId: string;
	policyRevision: number;
}
export interface EvaluationReceiptV1 {
	digest: string;
	result: unknown;
	expiresAt: string;
}
export interface EvaluationDataTransactionV1 {
	now: Date;
	receiptExpiresAt: string;
	authorizationExpiresAt: string;
	principal: EvaluationPrincipalV1;
	scoreWorkBinding?: { datasetId: string; versionId: string };
	bindPolicy(policy: EvaluationPolicyV1): Promise<void>;
	principalExists(principal: EvaluationPrincipalV1): Promise<boolean>;
	dataset(id: string): Promise<EvaluationDatasetV1 | null>;
	datasets(): Promise<EvaluationDatasetV1[]>;
	saveDataset(value: EvaluationDatasetV1): Promise<void>;
	version(id: string): Promise<EvaluationVersionV1 | null>;
	versions(datasetId: string): Promise<EvaluationVersionV1[]>;
	saveVersion(value: EvaluationVersionV1): Promise<void>;
	grants(datasetId: string): Promise<EvaluationGrantV1[]>;
	grant(id: string): Promise<EvaluationGrantV1 | null>;
	saveGrant(value: EvaluationGrantV1): Promise<void>;
	receipt(key: string): Promise<EvaluationReceiptV1 | null>;
	saveReceipt(key: string, value: EvaluationReceiptV1): Promise<void>;
	audit(action: string, targetId: string): Promise<void>;
	deleteIntent(value: EvaluationVersionV1): Promise<void>;
}
export interface EvaluationDataStoreV1 {
	transaction<T>(
		request: EvaluationRequestV1,
		work: (tx: EvaluationDataTransactionV1) => Promise<T>,
	): Promise<T>;
}
/** Same ObjectStorageDataV1 structural surface, with a separate deployment-owned Eval namespace. */
export interface EvaluationStorageV1 {
	upload(input: {
		objectRef: string;
		descriptor: FileDescriptorV1;
		expiresAt: string;
		body: ReadableStream<Uint8Array>;
		signal?: AbortSignal;
	}): Promise<StoredFileObjectV1>;
	inspect(
		objectRef: string,
		version?: string,
	): Promise<StoredFileObjectV1 | null>;
	download(input: {
		objectRef: string;
		version: string;
		etag: string;
		expiresAt: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>>;
	remove(objectRef: string, version: string): Promise<unknown>;
}
export class EvaluationDataErrorV1 extends Error {
	constructor(
		readonly code: "invalid" | "denied" | "conflict" | "unavailable",
	) {
		super(`EVALUATION_${code.toUpperCase()}`);
	}
}
const fail = (code: EvaluationDataErrorV1["code"]): never => {
	throw new EvaluationDataErrorV1(code);
};
const text = (x: unknown, max = 256): string =>
	typeof x === "string" &&
	x.length > 0 &&
	x.length <= max &&
	x.isWellFormed() &&
	[...x].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
		? x
		: fail("invalid");
const content = (x: unknown, max: number): string =>
	typeof x === "string" &&
	x.length > 0 &&
	!x.includes("\0") &&
	x.isWellFormed() &&
	Buffer.byteLength(x, "utf8") <= max
		? x
		: fail("invalid");
const count = (x: unknown, max = Number.MAX_SAFE_INTEGER): number =>
	typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= max
		? x
		: fail("invalid");
const instant = (x: unknown): string =>
	typeof x === "string" &&
	Number.isFinite(Date.parse(x)) &&
	new Date(x).toISOString() === x
		? x
		: fail("invalid");
const exact = (x: unknown, keys: string[]) => {
	try {
		return snapshotObject(x, keys);
	} catch {
		return fail("invalid");
	}
};
const principal = (x: unknown): EvaluationPrincipalV1 => {
	try {
		return parseTaskPrincipalV1(exact(x, ["kind", "id"]));
	} catch {
		return fail("invalid");
	}
};
const same = (a: EvaluationPrincipalV1, b: EvaluationPrincipalV1) =>
	a.kind === b.kind && a.id === b.id;
function list<T>(x: unknown, parse: (x: unknown) => T, max = 100): T[] {
	if (!Array.isArray(x) || !x.length || x.length > max) return fail("invalid");
	const result = Array.from(x, (value) => parse(value));
	if (new Set(result.map((v) => JSON.stringify(v))).size !== result.length)
		return fail("invalid");
	return result;
}
function operation(x: unknown): EvaluationOperationV1 {
	return evaluationOperationsV1.includes(x as EvaluationOperationV1)
		? (x as EvaluationOperationV1)
		: fail("invalid");
}
export function parseEvaluationPolicyV1(input: unknown): EvaluationPolicyV1 {
	const v = exact(input, [
		"schemaVersion",
		"policyId",
		"revision",
		"validUntil",
		"managers",
		"retainedMetadataFields",
		"materialApprovals",
		"retention",
		"maxContentBytes",
		"transferTimeoutMs",
		"pendingMs",
	]);
	if (v.schemaVersion !== 1) return fail("invalid");
	const retainedMetadataFields = list(v.retainedMetadataFields, text);
	if (
		!isDeepStrictEqual(
			[...retainedMetadataFields].sort(),
			[...evaluationRetainedMetadataFieldsV1].sort(),
		)
	)
		return fail("invalid");
	const materialApprovals = list<
		EvaluationPolicyV1["materialApprovals"][number]
	>(v.materialApprovals, (input) => {
		const entry = exact(input, ["approvalId", "scope", "kind", "redactionRef"]);
		if (entry.kind !== "synthetic" && entry.kind !== "approved")
			return fail("invalid");
		if (
			(entry.kind === "approved" && entry.redactionRef === null) ||
			(entry.kind === "synthetic" && entry.redactionRef !== null)
		)
			return fail("invalid");
		return {
			approvalId: text(entry.approvalId),
			scope: text(entry.scope),
			kind: entry.kind,
			redactionRef:
				entry.redactionRef === null ? null : text(entry.redactionRef),
		};
	});
	if (
		new Set(materialApprovals.map((x) => x.approvalId)).size !==
		materialApprovals.length
	)
		return fail("invalid");
	const managers = list(v.managers, (item) => {
		const m = exact(item, ["principal", "scopes", "operations", "maxGrantMs"]);
		return {
			principal: principal(m.principal),
			scopes: list(m.scopes, text),
			operations: list(m.operations, operation),
			maxGrantMs: count(m.maxGrantMs),
		};
	});
	if (
		new Set(managers.map((m) => JSON.stringify(m.principal))).size !==
		managers.length
	)
		return fail("invalid");
	const r = exact(v.retention, [
		"samples",
		"rubric",
		"output",
		"score",
		"review",
	]);
	const retention = Object.fromEntries(
		Object.entries(r).map(([key, value]) => {
			const item = exact(value, [
				"startsAt",
				"contentMs",
				"metadataMs",
				"deleteWithinMs",
			]);
			const startsAt =
				key === "samples" || key === "rubric"
					? "version_reserved"
					: "content_created";
			if (item.startsAt !== startsAt) return fail("invalid");
			const result = {
				startsAt,
				contentMs: count(item.contentMs),
				metadataMs: count(item.metadataMs),
				deleteWithinMs: count(item.deleteWithinMs),
			};
			if (result.metadataMs < result.contentMs) return fail("invalid");
			return [key, result];
		}),
	) as EvaluationPolicyV1["retention"];
	return {
		schemaVersion: 1,
		policyId: text(v.policyId),
		revision: count(v.revision),
		validUntil: instant(v.validUntil),
		managers,
		retainedMetadataFields,
		materialApprovals,
		retention,
		maxContentBytes: count(v.maxContentBytes, 1024 * 1024),
		transferTimeoutMs: count(v.transferTimeoutMs, 60_000),
		pendingMs: count(v.pendingMs),
	};
}
function metadata(v: EvaluationVersionV1) {
	const {
		objectRef: _object,
		descriptor: _descriptor,
		stored: _stored,
		uploadActor: _actor,
		uploadGrantId: _grant,
		uploadGrantRevision: _revision,
		transferUntil: _transfer,
		...rest
	} = v;
	return rest;
}
export function validateEvaluationDatasetContentV1(bytes: Uint8Array) {
	let input: unknown;
	try {
		input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return fail("invalid");
	}
	const value = exact(input, [
		"schemaVersion",
		"provenance",
		"samples",
		"rubric",
	]);
	if (value.schemaVersion !== 1) return fail("invalid");
	const samples = list(
		value.samples,
		(entry) => {
			const v = exact(entry, [
				"id",
				"input",
				"context",
				"taskType",
				"expectedResult",
			]);
			return {
				id: text(v.id),
				input: content(v.input, 65536),
				context: v.context === null ? null : content(v.context, 65536),
				taskType: text(v.taskType),
				expectedResult:
					v.expectedResult === null ? null : content(v.expectedResult, 65536),
			};
		},
		1000,
	);
	if (new Set(samples.map((v) => v.id)).size !== samples.length)
		return fail("invalid");
	const rubric = list(value.rubric, (entry) => {
		const v = exact(entry, ["id", "description"]);
		return { id: text(v.id), description: content(v.description, 8192) };
	});
	if (new Set(rubric.map((v) => v.id)).size !== rubric.length)
		return fail("invalid");
	const provenance = exact(value.provenance, ["approvalId"]);
	return {
		schemaVersion: 1 as const,
		provenance: { approvalId: text(provenance.approvalId) },
		samples,
		rubric,
	};
}
export function createEvaluationDataV1(options: {
	store: EvaluationDataStoreV1;
	loadPolicy: () => Promise<unknown>;
	storage: EvaluationStorageV1;
}) {
	async function policy() {
		try {
			return parseEvaluationPolicyV1(await options.loadPolicy());
		} catch {
			return fail("unavailable");
		}
	}
	async function current<T>(
		request: EvaluationRequestV1,
		work: (
			tx: EvaluationDataTransactionV1,
			p: EvaluationPolicyV1,
		) => Promise<T>,
	) {
		const p = await policy();
		return options.store.transaction(request, async (tx) => {
			if (Date.parse(p.validUntil) <= +tx.now) return fail("unavailable");
			tx.authorizationExpiresAt = p.validUntil;
			await tx.bindPolicy(p);
			tx.receiptExpiresAt = new Date(
				+tx.now +
					Math.min(
						p.retention.samples.metadataMs,
						p.retention.rubric.metadataMs,
					),
			).toISOString();
			const result = await work(tx, p);
			if (
				!isDeepStrictEqual(p, await policy()) ||
				Date.parse(p.validUntil) <= Date.now()
			)
				return fail("unavailable");
			return result;
		});
	}
	const manager = (
		tx: EvaluationDataTransactionV1,
		p: EvaluationPolicyV1,
		scope: string,
		op: EvaluationOperationV1,
	) => {
		if (tx.scoreWorkBinding) return fail("denied");
		const m = p.managers.find(
			(m) =>
				same(m.principal, tx.principal) &&
				m.scopes.includes(scope) &&
				m.operations.includes(op),
		);
		if (!m) return fail("denied");
		return m;
	};
	async function dataset(tx: EvaluationDataTransactionV1, id: string) {
		const d = await tx.dataset(text(id));

		if (!d || Date.parse(d.metadataExpiresAt) <= +tx.now) return fail("denied");
		tx.authorizationExpiresAt = new Date(
			Math.min(
				Date.parse(tx.authorizationExpiresAt),
				Date.parse(d.metadataExpiresAt),
			),
		).toISOString();
		tx.receiptExpiresAt = new Date(
			Math.min(
				Date.parse(tx.receiptExpiresAt),
				Date.parse(d.metadataExpiresAt),
			),
		).toISOString();
		return d;
	}
	async function permission(
		tx: EvaluationDataTransactionV1,
		p: EvaluationPolicyV1,
		v: EvaluationVersionV1,
		op: EvaluationOperationV1,
		allowRetired = false,
	) {
		if (
			tx.scoreWorkBinding &&
			(tx.scoreWorkBinding.datasetId !== v.datasetId ||
				tx.scoreWorkBinding.versionId !== v.versionId ||
				op !== "score")
		)
			return fail("denied");
		if (
			!allowRetired &&
			(v.status === "deleted" ||
				v.status === "deleting" ||
				Math.min(
					Date.parse(v.expiresAt),
					Date.parse(v.createdAt) + p.retention.samples.contentMs,
					Date.parse(v.createdAt) + p.retention.rubric.contentMs,
				) <= +tx.now)
		)
			return fail("denied");
		const grants = await tx.grants(v.datasetId);
		const g = grants.find(
			(g) =>
				same(g.principal, tx.principal) &&
				!g.revoked &&
				g.policyId === p.policyId &&
				g.policyRevision === p.revision &&
				Date.parse(g.expiresAt) > +tx.now &&
				g.versionIds.includes(v.versionId) &&
				g.operations.includes(op),
		);
		if (!g) return fail("denied");
		tx.authorizationExpiresAt = new Date(
			Math.min(
				Date.parse(tx.authorizationExpiresAt),
				Date.parse(g.expiresAt),
				...(allowRetired
					? []
					: [
							Date.parse(v.expiresAt),
							Date.parse(v.createdAt) + p.retention.samples.contentMs,
							Date.parse(v.createdAt) + p.retention.rubric.contentMs,
						]),
			),
		).toISOString();
		return g;
	}
	async function version(
		tx: EvaluationDataTransactionV1,
		datasetId: string,
		versionId: string,
	) {
		await dataset(tx, datasetId);
		const v = await tx.version(text(versionId));
		if (
			!v ||
			v.datasetId !== datasetId ||
			Date.parse(v.metadataExpiresAt) <= +tx.now
		)
			return fail("denied");
		tx.receiptExpiresAt = new Date(
			Math.min(
				Date.parse(tx.receiptExpiresAt),
				Date.parse(v.metadataExpiresAt),
			),
		).toISOString();
		tx.authorizationExpiresAt = new Date(
			Math.min(
				Date.parse(tx.authorizationExpiresAt),
				Date.parse(v.metadataExpiresAt),
			),
		).toISOString();
		return v;
	}
	async function mutate<T>(
		tx: EvaluationDataTransactionV1,
		key: string,
		command: unknown,
		action: string,
		target: string,
		work: () => Promise<T>,
	) {
		text(key, 128);
		const digest = createHash("sha256")
			.update(JSON.stringify(command))
			.digest("hex");
		const scope = JSON.stringify([tx.principal, action, target, key]);
		const saved = await tx.receipt(scope);
		if (saved) {
			if (Date.parse(saved.expiresAt) <= +tx.now) return fail("conflict");
			if (saved.digest !== digest) return fail("conflict");

			try {
				if (action === "evaluation.dataset.create") {
					if (parseEvaluationDatasetV1(saved.result).scope !== target)
						return fail("unavailable");
				} else if (
					action === "evaluation.grant.create" ||
					action === "evaluation.grant.revoke"
				) {
					if (parseEvaluationGrantV1(saved.result).datasetId !== target)
						return fail("unavailable");
				} else if (action === "evaluation.content.write") {
					const receipt = exact(saved.result, ["objectRef", "revision"]);
					uuid(receipt.objectRef);
					count(receipt.revision);
				} else if (
					action === "evaluation.version.reserve" ||
					action === "evaluation.content.delete"
				) {
					const receipt = exact(saved.result, [
						"versionId",
						"datasetId",
						"sourceVersionId",
						"revision",
						"status",
						"createdAt",
						"expiresAt",
						"metadataExpiresAt",
						"deleteBy",
						"policyId",
						"policyRevision",
						"materialApprovalId",
					]);
					uuid(receipt.versionId);
					uuid(receipt.datasetId);
					if (receipt.sourceVersionId !== null) uuid(receipt.sourceVersionId);
					count(receipt.revision);
					count(receipt.policyRevision);
					text(receipt.policyId);
					if (receipt.materialApprovalId !== null)
						text(receipt.materialApprovalId);
					for (const field of [
						"createdAt",
						"expiresAt",
						"metadataExpiresAt",
						"deleteBy",
					])
						instant(receipt[field]);
					if (
						receipt.datasetId !== target ||
						receipt.status !==
							(action === "evaluation.version.reserve" ? "pending" : "deleting")
					)
						return fail("unavailable");
				} else return fail("unavailable");
			} catch {
				return fail("unavailable");
			}
			return saved.result as T;
		}
		const result = await work();
		await tx.audit(action, target);
		await tx.saveReceipt(scope, {
			digest,
			result,
			expiresAt: tx.receiptExpiresAt,
		});
		return result;
	}
	async function deleting(
		tx: EvaluationDataTransactionV1,
		v: EvaluationVersionV1,
	) {
		if (v.status === "deleted") return;
		v.deleteBy = new Date(
			Math.min(
				Date.parse(v.deleteBy),
				+tx.now + Math.max(0, Date.parse(v.deleteBy) - Date.parse(v.expiresAt)),
			),
		).toISOString();
		v.status = "deleting";
		v.revision++;
		await tx.saveVersion(v);
		await tx.deleteIntent(v);
	}
	async function readForPurpose(
		request: EvaluationRequestV1,
		datasetId: string,
		versionId: string,
		operation: "read" | "run" | "score" | "review",
	) {
		const before = await current(request, async (tx, p) => {
			const v = await version(tx, datasetId, versionId);
			const g = await permission(tx, p, v, operation);
			if (v.status !== "available" || !v.stored) return fail("denied");
			return { version: v, grant: g, policy: p };
		});
		const stored = before.version.stored ?? fail("unavailable");
		let bytes: Uint8Array;
		try {
			const stream = await options.storage.download({
				objectRef: before.version.objectRef,
				version: stored.version,
				etag: stored.etag,
				expiresAt: new Date(
					Date.now() + before.policy.transferTimeoutMs,
				).toISOString(),
				signal: AbortSignal.timeout(before.policy.transferTimeoutMs),
			});
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of stream) {
				size += chunk.length;
				if (size > before.policy.maxContentBytes) return fail("unavailable");
				chunks.push(chunk);
			}
			bytes = Buffer.concat(chunks);
		} catch {
			return fail("unavailable");
		}
		if (
			bytes.length !== stored.sizeBytes ||
			createHash("sha256").update(bytes).digest("hex") !== stored.sha256
		)
			return fail("unavailable");
		return current(request, async (tx, p) => {
			const v = await version(tx, datasetId, versionId);
			const g = await permission(tx, p, v, operation);
			if (
				v.revision !== before.version.revision ||
				g.grantId !== before.grant.grantId ||
				g.revision !== before.grant.revision ||
				!isDeepStrictEqual(p, before.policy)
			)
				return fail("denied");
			await tx.audit("evaluation.content.read", datasetId);
			return {
				content: validateEvaluationDatasetContentV1(bytes),
				version: v,
				grant: g,
				policy: p,
				principal: tx.principal,
				scope: (await dataset(tx, datasetId)).scope,
			};
		});
	}
	async function authorizePurpose(
		request: EvaluationRequestV1,
		datasetId: string,
		versionId: string,
		operation: "run" | "score" | "review",
	) {
		return current(request, async (tx, p) => {
			const v = await version(tx, datasetId, versionId);
			const g = await permission(tx, p, v, operation);
			if (v.status !== "available" || !v.stored) return fail("denied");
			return {
				version: v,
				grant: g,
				policy: p,
				principal: tx.principal,
				scope: (await dataset(tx, datasetId)).scope,
			};
		});
	}
	return {
		async list(request: EvaluationRequestV1) {
			return current(request, async (tx, p) => {
				const items = [];
				for (const d of await tx.datasets()) {
					if (Date.parse(d.metadataExpiresAt) <= +tx.now) continue;
					const manages = p.managers.some(
						(m) =>
							same(m.principal, tx.principal) && m.scopes.includes(d.scope),
					);
					const grants = await tx.grants(d.datasetId);
					const visible = grants.some(
						(g) =>
							same(g.principal, tx.principal) &&
							!g.revoked &&
							g.policyId === p.policyId &&
							g.policyRevision === p.revision &&
							Date.parse(g.expiresAt) > +tx.now,
					);
					if (!manages && !visible) continue;
					tx.authorizationExpiresAt = new Date(
						Math.min(
							Date.parse(tx.authorizationExpiresAt),
							Date.parse(d.metadataExpiresAt),
						),
					).toISOString();
					if (!manages)
						for (const grant of grants)
							if (
								same(grant.principal, tx.principal) &&
								!grant.revoked &&
								grant.policyId === p.policyId &&
								grant.policyRevision === p.revision &&
								Date.parse(grant.expiresAt) > +tx.now
							)
								tx.authorizationExpiresAt = new Date(
									Math.min(
										Date.parse(tx.authorizationExpiresAt),
										Date.parse(grant.expiresAt),
									),
								).toISOString();
					const versions = (await tx.versions(d.datasetId)).filter(
						(v) =>
							Date.parse(v.metadataExpiresAt) > +tx.now &&
							(manages ||
								grants.some(
									(g) =>
										same(g.principal, tx.principal) &&
										!g.revoked &&
										g.policyId === p.policyId &&
										g.policyRevision === p.revision &&
										Date.parse(g.expiresAt) > +tx.now &&
										g.versionIds.includes(v.versionId),
								)),
					);
					for (const v of versions)
						tx.authorizationExpiresAt = new Date(
							Math.min(
								Date.parse(tx.authorizationExpiresAt),
								Date.parse(v.metadataExpiresAt),
							),
						).toISOString();
					items.push({
						...d,
						versions: versions.map(metadata),
						grants: p.managers.some(
							(m) =>
								same(m.principal, tx.principal) &&
								m.scopes.includes(d.scope) &&
								m.operations.includes("manage_grants"),
						)
							? grants
							: grants.filter((g) => same(g.principal, tx.principal)),
					});
				}
				await tx.audit("evaluation.dataset.list", "evaluation");
				return { schemaVersion: 1 as const, items };
			});
		},
		async create(
			request: EvaluationRequestV1,
			key: string,
			input: { scope: string; name: string },
		) {
			return current(request, async (tx, p) => {
				manager(tx, p, text(input.scope), "create");
				text(input.name, 120);
				return mutate(
					tx,
					key,
					input,
					"evaluation.dataset.create",
					input.scope,
					async () => {
						const d: EvaluationDatasetV1 = {
							datasetId: randomUUID(),
							scope: input.scope,
							name: input.name,
							revision: 1,
							createdAt: tx.now.toISOString(),
							metadataExpiresAt: new Date(
								+tx.now +
									Math.min(
										p.retention.samples.metadataMs,
										p.retention.rubric.metadataMs,
									),
							).toISOString(),
						};
						await tx.saveDataset(d);
						return d;
					},
				);
			});
		},
		async reserve(
			request: EvaluationRequestV1,
			key: string,
			datasetId: string,
			input: { expectedRevision: number; sourceVersionId: string | null },
		) {
			return current(request, async (tx, p) => {
				const d = await dataset(tx, datasetId);
				manager(tx, p, d.scope, "import");
				return mutate(
					tx,
					key,
					input,
					"evaluation.version.reserve",
					d.datasetId,
					async () => {
						if (d.revision !== count(input.expectedRevision))
							return fail("conflict");
						if (input.sourceVersionId !== null) {
							const prior = await version(tx, datasetId, input.sourceVersionId);
							if (prior.status !== "available") return fail("conflict");
						}
						const retention = [p.retention.samples, p.retention.rubric];
						const v: EvaluationVersionV1 = {
							versionId: randomUUID(),
							datasetId,
							sourceVersionId: input.sourceVersionId,
							revision: 1,
							status: "pending",
							createdAt: tx.now.toISOString(),
							expiresAt: new Date(
								+tx.now +
									Math.min(p.pendingMs, ...retention.map((r) => r.contentMs)),
							).toISOString(),
							metadataExpiresAt: new Date(
								+tx.now + Math.min(...retention.map((r) => r.metadataMs)),
							).toISOString(),
							deleteBy: new Date(
								+tx.now +
									Math.min(p.pendingMs, ...retention.map((r) => r.contentMs)) +
									Math.min(...retention.map((r) => r.deleteWithinMs)),
							).toISOString(),
							policyId: p.policyId,
							policyRevision: p.revision,
							objectRef: randomUUID(),
							materialApprovalId: null,
							descriptor: null,
							stored: null,
							uploadActor: null,
							uploadGrantId: null,
							uploadGrantRevision: null,
							transferUntil: null,
						};
						d.revision++;
						d.metadataExpiresAt = new Date(
							Math.max(
								Date.parse(d.metadataExpiresAt),
								Date.parse(v.metadataExpiresAt),
							),
						).toISOString();
						await tx.saveDataset(d);
						await tx.saveVersion(v);
						return metadata(v);
					},
				);
			});
		},
		async grant(
			request: EvaluationRequestV1,
			key: string,
			datasetId: string,
			input: {
				expectedRevision: number;
				principal: EvaluationPrincipalV1;
				versionIds: string[];
				operations: EvaluationOperationV1[];
				expiresAt: string;
			},
		) {
			return current(request, async (tx, p) => {
				const d = await dataset(tx, datasetId);
				const m = manager(tx, p, d.scope, "manage_grants");
				const receiver = principal(input.principal);
				if (!(await tx.principalExists(receiver))) return fail("denied");
				const operations = list(input.operations, operation);
				const ids = list(input.versionIds, text);
				const expiresAt = instant(input.expiresAt);
				if (
					operations.some(
						(op) =>
							!m.operations.includes(op) ||
							["create", "manage_grants"].includes(op),
					) ||
					Date.parse(expiresAt) <= +tx.now ||
					Date.parse(expiresAt) >
						Math.min(Date.parse(p.validUntil), +tx.now + m.maxGrantMs)
				)
					return fail("denied");
				for (const id of ids) {
					const v = await version(tx, datasetId, id);
					if (v.status === "deleted" || v.status === "deleting")
						return fail("denied");
				}
				return mutate(
					tx,
					key,
					input,
					"evaluation.grant.create",
					datasetId,
					async () => {
						if (d.revision !== count(input.expectedRevision))
							return fail("conflict");
						const g: EvaluationGrantV1 = {
							grantId: randomUUID(),
							datasetId,
							versionIds: ids,
							principal: receiver,
							operations,
							expiresAt,
							revision: 1,
							revoked: false,
							issuer: tx.principal,
							policyId: p.policyId,
							policyRevision: p.revision,
						};
						d.revision++;
						await tx.saveDataset(d);
						await tx.saveGrant(g);
						return g;
					},
				);
			});
		},
		async revoke(
			request: EvaluationRequestV1,
			key: string,
			datasetId: string,
			grantId: string,
			expectedRevision: number,
		) {
			return current(request, async (tx, p) => {
				const d = await dataset(tx, datasetId);
				manager(tx, p, d.scope, "manage_grants");
				const g = await tx.grant(text(grantId));
				if (!g || g.datasetId !== datasetId) return fail("denied");
				return mutate(
					tx,
					key,
					{ grantId, expectedRevision },
					"evaluation.grant.revoke",
					datasetId,
					async () => {
						if (g.revision !== count(expectedRevision)) return fail("conflict");
						g.revoked = true;
						g.revision++;
						await tx.saveGrant(g);
						return g;
					},
				);
			});
		},
		async upload(
			request: EvaluationRequestV1,
			key: string,
			datasetId: string,
			versionId: string,
			bytes: Uint8Array,
		) {
			const p = await policy();
			if (bytes.length === 0 || bytes.length > p.maxContentBytes)
				return fail("invalid");
			const imported = validateEvaluationDatasetContentV1(bytes);
			const descriptor: FileDescriptorV1 = {
				name: "dataset.json",
				mediaType: "application/json",
				sizeBytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			const binding = await current(request, async (tx, policy) => {
				if (bytes.length > policy.maxContentBytes) return fail("invalid");
				const v = await version(tx, datasetId, versionId);
				const g = await permission(tx, policy, v, "import");
				const d = await dataset(tx, datasetId);
				if (
					!policy.materialApprovals.some(
						(entry) =>
							entry.approvalId === imported.provenance.approvalId &&
							entry.scope === d.scope,
					)
				)
					return fail("denied");
				const binding = await mutate(
					tx,
					key,
					{ versionId, descriptor },
					"evaluation.content.write",
					datasetId,
					async () => {
						if (v.status !== "pending") return fail("conflict");
						v.status = "uploading";
						v.revision++;
						v.descriptor = descriptor;
						v.materialApprovalId = imported.provenance.approvalId;
						v.uploadActor = tx.principal;
						v.uploadGrantId = g.grantId;
						v.uploadGrantRevision = g.revision;
						v.transferUntil = new Date(
							+tx.now + policy.transferTimeoutMs + 5000,
						).toISOString();
						await tx.saveVersion(v);
						return { objectRef: v.objectRef, revision: v.revision };
					},
				);
				if (
					binding.objectRef !== v.objectRef ||
					!v.descriptor ||
					!isDeepStrictEqual(v.descriptor, descriptor)
				)
					return fail("unavailable");
				if (v.status === "uploading") {
					v.transferUntil = new Date(
						+tx.now + policy.transferTimeoutMs + 5000,
					).toISOString();
					await tx.saveVersion(v);
				}
				return {
					...binding,
					transferUntil: v.transferUntil,
					available: v.status === "available",
					transferTimeoutMs: policy.transferTimeoutMs,
				};
			});
			const expiresAt = new Date(
				Math.min(
					Date.now() + binding.transferTimeoutMs,
					binding.transferUntil
						? Date.parse(binding.transferUntil) - 5000
						: Date.now() + binding.transferTimeoutMs,
				),
			).toISOString();
			if (binding.available) return this.confirm(request, datasetId, versionId);
			try {
				const present = await options.storage.inspect(binding.objectRef);
				if (!present)
					await options.storage.upload({
						objectRef: binding.objectRef,
						descriptor,
						expiresAt,
						signal: AbortSignal.timeout(binding.transferTimeoutMs),
						body: new ReadableStream({
							start(controller) {
								controller.enqueue(bytes);
								controller.close();
							},
						}),
					});
			} catch {
				return fail("unavailable");
			}
			return this.confirm(request, datasetId, versionId);
		},
		async confirm(
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) {
			const before = await current(request, async (tx, p) => {
				const v = await version(tx, datasetId, versionId);
				await permission(tx, p, v, "import");
				return v;
			});
			if (!before.descriptor || !before.uploadActor) return fail("conflict");
			let stored: StoredFileObjectV1 | null;
			try {
				stored = await options.storage.inspect(
					before.objectRef,
					before.stored?.version,
				);
			} catch {
				return fail("unavailable");
			}
			if (
				!stored ||
				stored.sha256 !== before.descriptor.sha256 ||
				stored.sizeBytes !== before.descriptor.sizeBytes ||
				stored.mediaType !== before.descriptor.mediaType ||
				!stored.version ||
				!stored.etag
			)
				return fail("conflict");
			return current(request, async (tx, p) => {
				const v = await version(tx, datasetId, versionId);
				const g = await permission(tx, p, v, "import");
				if (
					!same(tx.principal, v.uploadActor ?? fail("denied")) ||
					g.grantId !== v.uploadGrantId ||
					g.revision !== v.uploadGrantRevision ||
					v.policyId !== p.policyId ||
					v.policyRevision !== p.revision
				)
					return fail("denied");
				if (v.status === "available") {
					if (!isDeepStrictEqual(v.stored, stored)) return fail("conflict");
					return metadata(v);
				}
				if (v.status !== "uploading" || v.revision !== before.revision)
					return fail("conflict");
				v.status = "available";
				v.stored = stored;
				v.transferUntil = null;
				v.revision++;
				v.expiresAt = new Date(
					Date.parse(v.createdAt) +
						Math.min(
							p.retention.samples.contentMs,
							p.retention.rubric.contentMs,
						),
				).toISOString();
				v.deleteBy = new Date(
					Date.parse(v.expiresAt) +
						Math.min(
							p.retention.samples.deleteWithinMs,
							p.retention.rubric.deleteWithinMs,
						),
				).toISOString();
				await tx.saveVersion(v);
				await tx.audit("evaluation.content.confirm", datasetId);
				return metadata(v);
			});
		},
		read: async (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) => (await readForPurpose(request, datasetId, versionId, "read")).content,
		readForRun: (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) =>
			readForPurpose(
				{ ...request, credentialScope: "eval:run" },
				datasetId,
				versionId,
				"run",
			),
		readForScore: (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) =>
			readForPurpose(
				{ ...request, credentialScope: "eval:score" },
				datasetId,
				versionId,
				"score",
			),
		readForReview: (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) =>
			readForPurpose(
				{ ...request, credentialScope: "eval:review" },
				datasetId,
				versionId,
				"review",
			),
		authorizeRun: (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) =>
			authorizePurpose(
				{ ...request, credentialScope: "eval:run" },
				datasetId,
				versionId,
				"run",
			),
		authorizeScore: (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) =>
			authorizePurpose(
				{ ...request, credentialScope: "eval:score" },
				datasetId,
				versionId,
				"score",
			),
		authorizeReview: (
			request: EvaluationRequestV1,
			datasetId: string,
			versionId: string,
		) =>
			authorizePurpose(
				{ ...request, credentialScope: "eval:review" },
				datasetId,
				versionId,
				"review",
			),
		async remove(
			request: EvaluationRequestV1,
			key: string,
			datasetId: string,
			versionId: string,
			expectedRevision: number,
		) {
			return current(request, async (tx, p) => {
				const v = await version(tx, datasetId, versionId);
				await permission(tx, p, v, "delete", true);
				return mutate(
					tx,
					key,
					{ versionId, expectedRevision },
					"evaluation.content.delete",
					datasetId,
					async () => {
						if (
							v.status === "deleted" ||
							v.status === "deleting" ||
							v.revision !== count(expectedRevision)
						)
							return fail("conflict");
						await deleting(tx, v);
						return metadata(v);
					},
				);
			});
		},
	};
}

/** Persisted JSON is untrusted input, including when a database has been partially upgraded. */
export function parseEvaluationDatasetV1(input: unknown): EvaluationDatasetV1 {
	const v = exact(input, [
		"datasetId",
		"scope",
		"name",
		"revision",
		"createdAt",
		"metadataExpiresAt",
	]);
	return {
		datasetId: uuid(v.datasetId),
		scope: text(v.scope),
		name: text(v.name, 120),
		revision: count(v.revision),
		createdAt: instant(v.createdAt),
		metadataExpiresAt: instant(v.metadataExpiresAt),
	};
}
function uuid(input: unknown): string {
	const s = text(input, 36);
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(s)
	)
		return fail("invalid");
	return s;
}
export function parseEvaluationGrantV1(input: unknown): EvaluationGrantV1 {
	const v = exact(input, [
		"grantId",
		"datasetId",
		"versionIds",
		"principal",
		"operations",
		"expiresAt",
		"revision",
		"revoked",
		"issuer",
		"policyId",
		"policyRevision",
	]);
	if (typeof v.revoked !== "boolean") return fail("invalid");
	return {
		grantId: uuid(v.grantId),
		datasetId: uuid(v.datasetId),
		versionIds: list(v.versionIds, uuid),
		principal: principal(v.principal),
		operations: list(v.operations, operation),
		expiresAt: instant(v.expiresAt),
		revision: count(v.revision),
		revoked: v.revoked,
		issuer: principal(v.issuer),
		policyId: text(v.policyId),
		policyRevision: count(v.policyRevision),
	};
}
export function parseEvaluationVersionV1(input: unknown): EvaluationVersionV1 {
	const v = exact(input, [
		"versionId",
		"datasetId",
		"sourceVersionId",
		"revision",
		"status",
		"createdAt",
		"expiresAt",
		"metadataExpiresAt",
		"deleteBy",
		"policyId",
		"policyRevision",
		"objectRef",
		"materialApprovalId",
		"descriptor",
		"stored",
		"uploadActor",
		"uploadGrantId",
		"uploadGrantRevision",
		"transferUntil",
	]);
	const status = v.status;
	if (
		status !== "pending" &&
		status !== "uploading" &&
		status !== "available" &&
		status !== "deleting" &&
		status !== "deleted"
	)
		return fail("invalid");
	let descriptor: FileDescriptorV1 | null = null;
	if (v.descriptor !== null) {
		const d = exact(v.descriptor, ["name", "mediaType", "sizeBytes", "sha256"]);
		if (
			d.name !== "dataset.json" ||
			d.mediaType !== "application/json" ||
			!/^[a-f0-9]{64}$/u.test(text(d.sha256))
		)
			return fail("invalid");
		descriptor = {
			name: d.name,
			mediaType: d.mediaType,
			sizeBytes: count(d.sizeBytes, 8 * 1024 * 1024),
			sha256: text(d.sha256),
		};
	}
	let stored: StoredFileObjectV1 | null = null;
	if (v.stored !== null) {
		const s = exact(v.stored, [
			"version",
			"etag",
			"sizeBytes",
			"mediaType",
			"sha256",
		]);
		if (
			!descriptor ||
			s.sizeBytes !== descriptor.sizeBytes ||
			s.mediaType !== descriptor.mediaType ||
			s.sha256 !== descriptor.sha256
		)
			return fail("invalid");
		stored = {
			version: text(s.version),
			etag: text(s.etag),
			sizeBytes: descriptor.sizeBytes,
			mediaType: descriptor.mediaType,
			sha256: descriptor.sha256,
		};
	}
	if (status === "available" && (!stored || !descriptor))
		return fail("invalid");
	if (
		(status === "available" || status === "uploading") &&
		(v.materialApprovalId === null ||
			v.uploadActor === null ||
			v.uploadGrantId === null ||
			v.uploadGrantRevision === null ||
			!descriptor)
	)
		return fail("invalid");
	if (
		(status === "pending" || status === "deleted") &&
		(v.descriptor !== null ||
			v.stored !== null ||
			v.uploadActor !== null ||
			v.uploadGrantId !== null ||
			v.uploadGrantRevision !== null)
	)
		return fail("invalid");
	return {
		versionId: uuid(v.versionId),
		datasetId: uuid(v.datasetId),
		sourceVersionId:
			v.sourceVersionId === null ? null : uuid(v.sourceVersionId),
		revision: count(v.revision),
		status,
		createdAt: instant(v.createdAt),
		expiresAt: instant(v.expiresAt),
		metadataExpiresAt: instant(v.metadataExpiresAt),
		deleteBy: instant(v.deleteBy),
		policyId: text(v.policyId),
		policyRevision: count(v.policyRevision),
		objectRef: uuid(v.objectRef),
		materialApprovalId:
			v.materialApprovalId === null ? null : text(v.materialApprovalId),
		transferUntil: v.transferUntil === null ? null : instant(v.transferUntil),
		descriptor,
		stored,
		uploadActor: v.uploadActor === null ? null : principal(v.uploadActor),
		uploadGrantId: v.uploadGrantId === null ? null : uuid(v.uploadGrantId),
		uploadGrantRevision:
			v.uploadGrantRevision === null ? null : count(v.uploadGrantRevision),
	};
}
