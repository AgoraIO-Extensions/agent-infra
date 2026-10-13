import { describe, expect, it, vi } from "vitest";
import { createPlatformNativeMetadataGatewayAssemblyV1 } from "./native-metadata-deployment-assembly.js";

const ports = {
	binding: { resolve: vi.fn(async () => null) },
	current: { check: vi.fn(async () => ({ outcome: "unavailable" as const })) },
	proofIssuer: {
		issue: vi.fn(async () => ({
			schemaVersion: 1 as const,
			format: "native-metadata-jws" as const,
			token: "proof",
		})),
	},
	transport: { resolve: vi.fn(async () => null) },
	port: 3010,
};

describe("native metadata deployment assembly", () => {
	it("builds the real Worker gateway app from deployment ports", async () => {
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports,
		});
		expect(options.port).toBe(3010);
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("rejects an invalid deployment service token", () => {
		expect(() =>
			createPlatformNativeMetadataGatewayAssemblyV1({
				serviceToken: "",
				ports,
			}),
		).toThrow("Platform Worker service token is invalid");
	});
});
