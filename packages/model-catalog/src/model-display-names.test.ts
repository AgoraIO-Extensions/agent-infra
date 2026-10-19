import { describe, expect, it, vi } from "vitest";
import { catalogFixture } from "./catalog.fixture.js";
import { createDeploymentModelDisplayNamesV1 } from "./model-display-names.js";

const model = { endpointId: "endpoint-a", modelId: "model-opaque-1" };
const entry = { ...model, displayName: "团队推理模型" };
const signal = () => AbortSignal.timeout(1000);
const metadata = (models: unknown[] = [entry]) => ({
	schemaVersion: 1,
	models,
});
const catalog = () => ({
	revision: "catalog-a",
	load: async () => catalogFixture(),
});

describe("trusted deployment model display names", () => {
	it("uses the exact endpoint/model pair and preserves unknown-name model IDs", async () => {
		const snapshot = catalogFixture();
		const endpoint = snapshot.endpoints[0];
		if (!endpoint) throw new Error("Catalog fixture endpoint missing");
		snapshot.endpoints.push({
			...endpoint,
			endpointId: "endpoint-b",
		});
		const before = structuredClone(snapshot);
		const read = createDeploymentModelDisplayNamesV1({
			metadata: metadata([
				entry,
				{ ...entry, endpointId: "endpoint-b", displayName: "另一模型" },
				{ ...entry, modelId: "model-other", displayName: entry.displayName },
			]),
			modelCatalog: { revision: "catalog-a", load: async () => snapshot },
		});
		const name = await read(signal());
		expect(name(model)).toBe("团队推理模型");
		expect(name({ ...model, endpointId: "endpoint-b" })).toBe("另一模型");
		expect(name({ ...model, modelId: "model-other" })).toBe(entry.displayName);
		expect(name({ ...model, modelId: "unlabelled-model" })).toBe(
			"unlabelled-model",
		);
		expect(snapshot).toEqual(before);
	});

	it("keeps deployments without names independent of an extra catalog read", async () => {
		const load = vi.fn(async () => {
			throw new Error("synthetic-sensitive-loader-error");
		});
		const name = await createDeploymentModelDisplayNamesV1({
			modelCatalog: { revision: "catalog-a", load },
		})(signal());
		expect(name(model)).toBe(model.modelId);
		expect(load).not.toHaveBeenCalled();
	});

	it.each([
		metadata([{ ...entry, displayName: "" }]),
		metadata([{ ...entry, displayName: " " }]),
		metadata([{ ...entry, displayName: " padded " }]),
		metadata([{ ...entry, displayName: "x".repeat(129) }]),
		metadata([{ ...entry, displayName: "name\nline" }]),
		metadata([{ ...entry, displayName: "name\u0085line" }]),
		metadata([{ ...entry, displayName: "name\u0000line" }]),
		metadata([{ ...entry, credential: "synthetic-sensitive-value" }]),
		metadata([entry, { ...entry, displayName: "duplicate pair" }]),
		{ ...metadata(), schemaVersion: 2 },
	])("rejects invalid metadata without echoing the input", (value) => {
		expect(() =>
			createDeploymentModelDisplayNamesV1({
				metadata: value,
				modelCatalog: catalog(),
			}),
		).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	});

	it("rejects unknown endpoints and models excluded by a finite catalog policy", async () => {
		const snapshot = catalogFixture();
		for (const models of [
			[{ ...entry, endpointId: "endpoint-missing" }],
			[{ ...entry, modelId: "model-excluded" }],
		]) {
			const read = createDeploymentModelDisplayNamesV1({
				metadata: metadata(models),
				modelCatalog: {
					revision: "catalog-a",
					load: async () => ({
						...snapshot,
						endpoints: snapshot.endpoints.map((endpoint) => ({
							...endpoint,
							allowedModels: [model.modelId],
						})),
					}),
				},
			});
			await expect(read(signal())).rejects.toThrow(
				/^MODEL_CONFIGURATION_UNAVAILABLE$/,
			);
		}
	});

	it.each([{ revision: "catalog-b" }, { validUntil: 1 }])(
		"does not use stale catalog evidence for supplied labels",
		async (override) => {
			const read = createDeploymentModelDisplayNamesV1({
				metadata: metadata(),
				modelCatalog: {
					revision: "catalog-a",
					load: async () => ({ ...catalogFixture(), ...override }),
				},
			});
			await expect(read(signal())).rejects.toThrow(
				/^MODEL_CONFIGURATION_UNAVAILABLE$/,
			);
		},
	);

	it("bounds a cancelled loader and redacts dependency errors", async () => {
		const controller = new AbortController();
		const read = createDeploymentModelDisplayNamesV1({
			metadata: metadata(),
			modelCatalog: {
				revision: "catalog-a",
				load: () => new Promise(() => {}),
			},
		});
		const result = read(controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	});
});
