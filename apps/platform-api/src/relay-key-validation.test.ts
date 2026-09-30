import { createFakeModelCatalogAdapterV1 } from "@agent-infra/model-catalog";
import { describe, expect, it, vi } from "vitest";

import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

const key = "synthetic-personal-relay-key";
const url = "https://relay.example.test/v1/models";

function catalog(
	options: {
		readonly loopback?: boolean;
		readonly revision?: string;
		readonly messages?: boolean;
		readonly apiKey?: boolean;
	} = {},
) {
	const loopback = options.loopback ?? false;
	return createFakeModelCatalogAdapterV1({
		schemaVersion: 1,
		revision: options.revision ?? "catalog-a",
		validUntil: Date.now() + 60_000,
		endpoints: [
			{
				endpointId: "relay-a",
				baseUrl: loopback
					? "http://127.0.0.1:8080/v1"
					: "https://relay.example.test/v1",
				origin: loopback
					? "http://127.0.0.1:8080"
					: "https://relay.example.test",
				protocol: options.messages
					? "anthropic-messages-v1"
					: "openai-responses-v1",
				...(options.messages
					? { authentication: options.apiKey ? "api-key" : "bearer" }
					: {}),
				security: {
					tls: loopback ? "loopback-http" : "verify-peer",
					redirects: "reject",
				},
				capabilities: {
					streaming: true,
					tools: true,
					reasoningLevels: ["medium"],
				},
				allowedModels: ["model-a"],
				available: true,
			},
		],
	});
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function validator(
	fetcher: typeof fetch,
	options: {
		readonly loopback?: boolean;
		readonly revision?: string;
		readonly messages?: boolean;
		readonly apiKey?: boolean;
		readonly modelsUrl?: string;
		readonly timeoutMs?: number;
	} = {},
) {
	return createPersonalRelayKeyValidatorV1({
		catalog: catalog(options),
		endpointId: "relay-a",
		catalogRevision: "catalog-a",
		profile: "sub2api-v1-model-list",
		modelsUrl: options.modelsUrl ?? url,
		fetch: fetcher,
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
}

describe("personal Relay Key read-only validation", () => {
	it("requires a protected model-list response from the fixed TLS endpoint", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			json({ object: "list", data: [{ id: "model-a", object: "model" }] }),
		);
		await expect(validator(fetcher)(key)).resolves.toBe("valid");
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledWith(
			url,
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				headers: {
					Authorization: `Bearer ${key}`,
					Accept: "application/json",
				},
			}),
		);
	});

	it.each([401, 403])(
		"classifies Relay authentication status %i as invalid",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>(async () =>
				json({ error: "denied" }, status),
			);
			await expect(validator(fetcher)(key)).resolves.toBe("invalid");
		},
	);

	it.each([201, 302, 404, 429, 500, 503])(
		"treats non-authentication status %i as unavailable",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>(
				async () => new Response(null, { status }),
			);
			await expect(validator(fetcher)(key)).resolves.toBe("unavailable");
		},
	);

	it.each([
		json({ data: [{ id: "model-a" }] }),
		json({ object: "list", data: [{ name: "model-a" }] }),
		json({ object: "list", data: "model-a" }),
		new Response("not json", {
			headers: { "content-type": "application/json" },
		}),
		new Response("<html>ok</html>", {
			headers: { "content-type": "text/html" },
		}),
		new Response("x".repeat(262_145), {
			headers: { "content-type": "application/json" },
		}),
	])(
		"does not accept a malformed or oversized success body",
		async (response) => {
			const fetcher = vi.fn<typeof fetch>(async () => response);
			await expect(validator(fetcher)(key)).resolves.toBe("unavailable");
		},
	);

	it("does not call an empty model list an invalid credential", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			json({ object: "list", data: [] }),
		);
		await expect(validator(fetcher)(key)).resolves.toBe("unavailable");
	});

	it("does not call an unapproved, stale, non-TLS, or unsupported profile", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			json({ object: "list", data: [{ id: "model-a" }] }),
		);
		await expect(
			validator(fetcher, { revision: "catalog-b" })(key),
		).resolves.toBe("unavailable");
		await expect(validator(fetcher, { loopback: true })(key)).resolves.toBe(
			"unavailable",
		);
		await expect(validator(fetcher, { messages: true })(key)).resolves.toBe(
			"unavailable",
		);
		await expect(
			validator(fetcher, { messages: true, apiKey: true })(key),
		).resolves.toBe("unavailable");
		await expect(
			validator(fetcher, {
				modelsUrl: "https://relay.example.test/v1/responses",
			})(key),
		).resolves.toBe("unavailable");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("contains network, redirect, timeout and sensitive errors", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error(`network rejected ${key}`);
		});
		const result = await validator(fetcher)(key);
		expect(result).toBe("unavailable");
		expect(JSON.stringify(result)).not.toContain(key);
		const redirected = vi.fn<typeof fetch>(async () =>
			Response.redirect("https://other.example.test/models", 302),
		);
		await expect(validator(redirected)(key)).resolves.toBe("unavailable");
		const hanging = vi.fn<typeof fetch>(
			async (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error(key)),
						{
							once: true,
						},
					);
				}),
		);
		await expect(validator(hanging, { timeoutMs: 5 })(key)).resolves.toBe(
			"unavailable",
		);
	});
});
