import { afterEach, describe, expect, it } from "vitest";
import { createPlatformNativeMetadataGatewayOptionsV1 } from "./native-metadata-deployment.js";

const previous = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE;

afterEach(() => {
	if (previous === undefined)
		delete process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE;
	else process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE = previous;
});

describe("Worker native metadata deployment assembly", () => {
	it("loads the deployment-owned gateway options", async () => {
		process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE =
			"data:text/javascript,export const createPlatformNativeMetadataGatewayOptionsV1=()=>({app:{fetch:async()=>new Response('ok')},port:0})";
		const options = await createPlatformNativeMetadataGatewayOptionsV1(
			new AbortController().signal,
		);
		expect(options?.port).toBe(0);
		expect(options?.app.fetch).toEqual(expect.any(Function));
	});

	it("keeps the gateway absent when the deployment module has no export", async () => {
		process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE =
			"data:text/javascript,export const unrelated=true";
		await expect(
			createPlatformNativeMetadataGatewayOptionsV1(
				new AbortController().signal,
			),
		).resolves.toBeUndefined();
	});

	it("rejects a malformed deployment export", async () => {
		process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE =
			"data:text/javascript,export const createPlatformNativeMetadataGatewayOptionsV1=()=>({app:{}})";
		await expect(
			createPlatformNativeMetadataGatewayOptionsV1(
				new AbortController().signal,
			),
		).rejects.toThrow("PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_INVALID");
	});
});
