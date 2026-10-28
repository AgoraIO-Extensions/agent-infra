import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	EvaluationDataErrorV1,
	type EvaluationPolicyV1,
	type EvaluationStorageV1,
} from "./evaluation-data.js";
import {
	createEvaluationDerivedContentV1,
	type EvaluationDerivedContentPortV1,
	type EvaluationDerivedObjectV1,
} from "./evaluation-derived-content.js";

it("uses the current shorter review content policy without concealing authority or binding failures", async () => {
	const createdAt = new Date(Date.now() - 10000).toISOString();
	const future = new Date(Date.now() + 60000).toISOString();
	const object: EvaluationDerivedObjectV1 = {
		id: randomUUID(),
		datasetId: randomUUID(),
		versionId: randomUUID(),
		kind: "review",
		objectRef: randomUUID(),
		status: "available",
		sha256: "a".repeat(64),
		sizeBytes: 1,
		createdAt,
		expiresAt: future,
		metadataExpiresAt: future,
		deleteBy: future,
		transferUntil: future,
		stored: {
			sha256: "a".repeat(64),
			sizeBytes: 1,
			mediaType: "application/json",
			etag: "fixture",
			version: "fixture",
		},
	};
	const currentPolicy = {
		retention: { review: { contentMs: 1000, metadataMs: 120000 } },
	} as EvaluationPolicyV1;
	const authorize = vi.fn().mockResolvedValue({ policy: currentPolicy });
	const download = vi.fn();
	const store: EvaluationDerivedContentPortV1 = {
		authorize,
		get: async () => object,
		reserve: async () => {
			throw new Error("unused");
		},
		confirm: async () => {
			throw new Error("unused");
		},
	};
	const service = createEvaluationDerivedContentV1({
		store,
		storage: { download } as unknown as EvaluationStorageV1,
	});
	const request = {
		authentication: { kind: "browser" as const, userId: "reviewer" },
		requestId: "fixture",
		traceId: "fixture",
	};
	const binding = {
		id: object.id,
		datasetId: object.datasetId,
		versionId: object.versionId,
		kind: "review" as const,
	};
	expect(await service.readRetained(request, binding)).toEqual({
		contentStatus: "expired",
		value: null,
	});
	expect(download).not.toHaveBeenCalled();
	object.status = "deleting";
	expect(await service.readRetained(request, binding)).toEqual({
		contentStatus: "deleting",
		value: null,
	});
	object.status = "deleted";
	object.stored = null;
	expect(await service.readRetained(request, binding)).toEqual({
		contentStatus: "deleted",
		value: null,
	});
	authorize.mockRejectedValueOnce(new EvaluationDataErrorV1("denied"));
	await expect(service.readRetained(request, binding)).rejects.toMatchObject({
		code: "denied",
	});
	await expect(
		service.readRetained(request, { ...binding, versionId: randomUUID() }),
	).rejects.toMatchObject({ code: "unavailable" });
	object.metadataExpiresAt = new Date(Date.now() - 1).toISOString();
	await expect(service.readRetained(request, binding)).rejects.toMatchObject({
		code: "denied",
	});
});
