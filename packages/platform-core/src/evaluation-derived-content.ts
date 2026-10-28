import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotObject } from "./conversation-execution-values.js";
import {
	EvaluationDataErrorV1,
	type EvaluationGrantV1,
	type EvaluationPolicyV1,
	type EvaluationPrincipalV1,
	type EvaluationRequestV1,
	type EvaluationStorageV1,
	type EvaluationVersionV1,
} from "./evaluation-data.js";
import type { StoredFileObjectV1 } from "./file-authority.js";
export type EvaluationDerivedKindV1 = "output" | "score" | "review";
export interface EvaluationDerivedObjectV1 {
	id: string;
	datasetId: string;
	versionId: string;
	kind: EvaluationDerivedKindV1;
	objectRef: string;
	status: "pending" | "available" | "deleting" | "deleted";
	stored: StoredFileObjectV1 | null;
	sha256: string;
	sizeBytes: number;
	createdAt: string;
	expiresAt: string;
	metadataExpiresAt: string;
	deleteBy: string;
	transferUntil: string;
}
export interface EvaluationDerivedContentPortV1 {
	authorize(
		request: EvaluationRequestV1,
		datasetId: string,
		versionId: string,
		kind: EvaluationDerivedKindV1,
	): Promise<{
		version: EvaluationVersionV1;
		policy: EvaluationPolicyV1;
		grant: EvaluationGrantV1;
		principal: EvaluationPrincipalV1;
	}>;
	reserve(
		request: EvaluationRequestV1,
		key: string,
		value: EvaluationDerivedObjectV1,
	): Promise<EvaluationDerivedObjectV1>;
	confirm(
		request: EvaluationRequestV1,
		value: EvaluationDerivedObjectV1,
		stored: StoredFileObjectV1,
	): Promise<EvaluationDerivedObjectV1>;
	get(id: string): Promise<EvaluationDerivedObjectV1 | null>;
}
export function createEvaluationDerivedContentV1(options: {
	store: EvaluationDerivedContentPortV1;
	storage: EvaluationStorageV1;
}) {
	return {
		async write(
			request: EvaluationRequestV1,
			key: string,
			datasetId: string,
			versionId: string,
			kind: EvaluationDerivedKindV1,
			body: unknown,
		) {
			const binding = await options.store.authorize(
				request,
				datasetId,
				versionId,
				kind,
			);
			const bytes = new TextEncoder().encode(JSON.stringify(body));
			if (!bytes.length || bytes.length > binding.policy.maxContentBytes)
				throw new EvaluationDataErrorV1("invalid");
			const createdAt = new Date().toISOString();
			const retention = binding.policy.retention[kind];
			const expiresAt = new Date(
				Math.min(
					Date.parse(binding.version.expiresAt),
					Date.parse(createdAt) + retention.contentMs,
				),
			).toISOString();
			const intent = await options.store.reserve(request, key, {
				id: randomUUID(),
				datasetId,
				versionId,
				kind,
				objectRef: randomUUID(),
				status: "pending",
				stored: null,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				sizeBytes: bytes.length,
				createdAt,
				expiresAt,
				metadataExpiresAt: new Date(
					Math.min(
						Date.parse(binding.version.metadataExpiresAt),
						Date.parse(createdAt) + retention.metadataMs,
					),
				).toISOString(),
				deleteBy: new Date(
					Date.parse(expiresAt) + retention.deleteWithinMs,
				).toISOString(),
				transferUntil: new Date(
					Date.now() + binding.policy.transferTimeoutMs + 5000,
				).toISOString(),
			});
			const bound = await options.store.authorize(
				request,
				datasetId,
				versionId,
				kind,
			);
			if (
				!isDeepStrictEqual(bound, binding) ||
				bytes.length > bound.policy.maxContentBytes ||
				Date.parse(intent.expiresAt) <= Date.now()
			)
				throw new EvaluationDataErrorV1("denied");
			if (intent.status === "available") return intent;
			const present = await options.storage.inspect(intent.objectRef);
			if (
				present &&
				(present.sha256 !== intent.sha256 ||
					present.sizeBytes !== intent.sizeBytes ||
					present.mediaType !== "application/json")
			)
				throw new EvaluationDataErrorV1("unavailable");
			const stored =
				present ??
				(await options.storage.upload({
					objectRef: intent.objectRef,
					descriptor: {
						name: "evaluation.json",
						mediaType: "application/json",
						sizeBytes: bytes.length,
						sha256: intent.sha256,
					},
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(bytes);
							controller.close();
						},
					}),
					expiresAt: new Date(
						Math.min(
							Date.now() + bound.policy.transferTimeoutMs,
							Date.parse(intent.transferUntil) - 5000,
						),
					).toISOString(),
					signal: AbortSignal.timeout(bound.policy.transferTimeoutMs),
				}));
			const inspected = await options.storage.inspect(
				intent.objectRef,
				stored.version,
			);
			if (
				!inspected ||
				!isDeepStrictEqual(stored, inspected) ||
				stored.sha256 !== intent.sha256 ||
				stored.sizeBytes !== intent.sizeBytes
			)
				throw new EvaluationDataErrorV1("unavailable");
			await options.store.authorize(request, datasetId, versionId, kind);
			return options.store.confirm(request, intent, stored);
		},
		async read(
			request: EvaluationRequestV1,
			id: string,
			kind: EvaluationDerivedKindV1,
		) {
			const original = await options.store.get(id);
			if (
				!original ||
				original.kind !== kind ||
				original.status !== "available" ||
				!original.stored ||
				Date.parse(original.expiresAt) <= Date.now()
			)
				throw new EvaluationDataErrorV1("denied");
			const binding = await options.store.authorize(
				request,
				original.datasetId,
				original.versionId,
				kind,
			);
			const expiresAt = new Date(
				Math.min(
					Date.parse(original.expiresAt),
					Date.parse(original.createdAt) +
						binding.policy.retention[kind].contentMs,
				),
			).toISOString();
			if (Date.parse(expiresAt) <= Date.now())
				throw new EvaluationDataErrorV1("denied");
			const stream = await options.storage.download({
				objectRef: original.objectRef,
				version: original.stored.version,
				etag: original.stored.etag,
				expiresAt,
				signal: AbortSignal.timeout(binding.policy.transferTimeoutMs),
			});
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of stream) {
				size += chunk.length;
				if (size > binding.policy.maxContentBytes)
					throw new EvaluationDataErrorV1("unavailable");
				chunks.push(chunk);
			}
			const bytes = Buffer.concat(chunks);
			if (
				bytes.length !== original.sizeBytes ||
				createHash("sha256").update(bytes).digest("hex") !== original.sha256
			)
				throw new EvaluationDataErrorV1("unavailable");
			const latest = await options.store.authorize(
				request,
				original.datasetId,
				original.versionId,
				kind,
			);
			if (
				!isDeepStrictEqual(latest, binding) ||
				!isDeepStrictEqual(await options.store.get(id), original) ||
				Math.min(
					Date.parse(original.expiresAt),
					Date.parse(original.createdAt) +
						latest.policy.retention[kind].contentMs,
				) <= Date.now()
			)
				throw new EvaluationDataErrorV1("denied");
			return JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			) as unknown;
		},
	};
}

export function parseEvaluationDerivedObjectV1(
	input: unknown,
): EvaluationDerivedObjectV1 {
	const v = snapshotObject(input, [
		"id",
		"datasetId",
		"versionId",
		"kind",
		"objectRef",
		"status",
		"stored",
		"sha256",
		"sizeBytes",
		"createdAt",
		"expiresAt",
		"metadataExpiresAt",
		"deleteBy",
		"transferUntil",
	]);
	const text = (value: unknown) => {
		if (
			typeof value !== "string" ||
			!value ||
			value.length > 512 ||
			!value.isWellFormed()
		)
			throw new EvaluationDataErrorV1("unavailable");
		return value;
	};
	for (const key of ["id", "datasetId", "versionId", "objectRef"])
		if (
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
				text(v[key]),
			)
		)
			throw new EvaluationDataErrorV1("unavailable");
	if (
		!["output", "score", "review"].includes(text(v.kind)) ||
		!["pending", "available", "deleting", "deleted"].includes(text(v.status)) ||
		!/^[a-f0-9]{64}$/.test(text(v.sha256)) ||
		typeof v.sizeBytes !== "number" ||
		!Number.isSafeInteger(v.sizeBytes) ||
		v.sizeBytes < 1 ||
		v.sizeBytes > 1024 * 1024
	)
		throw new EvaluationDataErrorV1("unavailable");
	for (const key of [
		"createdAt",
		"expiresAt",
		"metadataExpiresAt",
		"deleteBy",
		"transferUntil",
	])
		if (
			!Number.isFinite(Date.parse(text(v[key]))) ||
			new Date(text(v[key])).toISOString() !== v[key]
		)
			throw new EvaluationDataErrorV1("unavailable");
	if (v.stored !== null) {
		const stored = snapshotObject(v.stored, [
			"sha256",
			"sizeBytes",
			"mediaType",
			"etag",
			"version",
		]);
		if (
			stored.sha256 !== v.sha256 ||
			stored.sizeBytes !== v.sizeBytes ||
			stored.mediaType !== "application/json"
		)
			throw new EvaluationDataErrorV1("unavailable");
		text(stored.etag);
		text(stored.version);
	}
	if (
		(v.status === "available" && v.stored === null) ||
		(v.status === "pending" && v.stored !== null)
	)
		throw new EvaluationDataErrorV1("unavailable");
	return v as unknown as EvaluationDerivedObjectV1;
}
