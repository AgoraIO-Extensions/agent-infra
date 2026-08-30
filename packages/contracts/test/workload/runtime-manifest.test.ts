import {
	RuntimeManifestV1Schema,
	resolveRuntimeManifestCapabilitiesV1,
} from "@agent-infra/contracts/workload";
import { describe, expect, it } from "vitest";

describe("Runtime Manifest V1 contract", () => {
	it("accepts only ACP for a platform-managed interaction entry", () => {
		expect(
			RuntimeManifestV1Schema.parse({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 8080 },
				health: { path: "/healthz" },
				capabilities: { supplementaryInstruction: false },
			}),
		).toMatchObject({ protocol: "acp" });
		expect(
			RuntimeManifestV1Schema.safeParse({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "vendor-rpc",
				service: { port: 8080 },
				health: { path: "/healthz" },
			}).success,
		).toBe(false);
	});

	it("normalizes missing declared capability keys to false", () => {
		expect(
			RuntimeManifestV1Schema.parse({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 8080 },
				health: { path: "/healthz" },
				capabilities: { modelSelection: true },
			}),
		).toMatchObject({
			capabilities: {
				modelSelection: true,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			},
		});
	});

	it("forbids protocol but ignores capabilities for self-managed images", () => {
		const manifest = {
			schemaVersion: 1,
			interactionMode: "self-managed",
			service: { port: 8080 },
			health: { path: "/ready" },
		} as const;
		expect(RuntimeManifestV1Schema.parse(manifest)).toEqual(manifest);
		expect(
			RuntimeManifestV1Schema.safeParse({ ...manifest, protocol: "acp" })
				.success,
		).toBe(false);
		expect(
			RuntimeManifestV1Schema.parse({
				...manifest,
				capabilities: { connection: true },
			}),
		).toMatchObject({ capabilities: { connection: true } });
		expect(
			resolveRuntimeManifestCapabilitiesV1({
				...manifest,
				capabilities: { connection: true },
			}),
		).toEqual({
			modelSelection: false,
			attachments: false,
			resultFiles: false,
			connection: false,
			supplementaryInstruction: false,
		});
		expect(
			RuntimeManifestV1Schema.safeParse({
				...manifest,
				capabilities: { providerSpecific: true },
			}).success,
		).toBe(false);
	});

	it.each(["identityResponsibility", "process", "storage", "route"])(
		"rejects non-Manifest field %s",
		(field) => {
			expect(
				RuntimeManifestV1Schema.safeParse({
					schemaVersion: 1,
					interactionMode: "platform-adapter",
					protocol: "acp",
					service: { port: 8080 },
					health: { path: "/healthz" },
					[field]: {},
				}).success,
			).toBe(false);
		},
	);

	it.each([
		"//health",
		"/a/../health",
		"/a/./health",
		"/a%2Fhealth",
		"/a?x=1",
		"/healthz\n",
	])("rejects unsafe health path %s", (path) => {
		expect(
			RuntimeManifestV1Schema.safeParse({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 8080 },
				health: { path },
			}).success,
		).toBe(false);
	});
});
