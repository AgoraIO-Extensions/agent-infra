import { describe, expect, it, vi } from "vitest";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

const billingUrl = "https://sub2api.la3.agoralab.co/v1/sub2api/billing";
const key = "SYNTHETIC_PERSONAL_KEY_SENTINEL";
const marker = {
	object: "sub2api.key_billing",
	schema_version: 1,
	billing_scope: "token",
};
function validator(fetch: typeof globalThis.fetch, timeoutMs = 100) {
	return createPersonalRelayKeyValidatorV1({
		profile: "sub2api-key-billing-v1",
		billingUrl,
		fetch,
		timeoutMs,
	});
}

describe("approved personal Relay Key billing authentication", () => {
	it("sends only the fixed read-only request and accepts the protocol marker", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ ...marker, quota: 0, expired: true }),
		);
		await expect(validator(fetch)(key)).resolves.toBe("valid");
		expect(fetch).toHaveBeenCalledWith(
			billingUrl,
			expect.objectContaining({
				method: "GET",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(Object.keys(fetch.mock.calls[0]?.[1] ?? {})).not.toContain("body");
	});
	it.each([401, 403, 301, 404, 429, 500, 204])(
		"classifies status %i without retaining its body",
		async (status) => {
			await expect(
				validator(
					async () => new Response(status === 204 ? null : key, { status }),
				)(key),
			).resolves.toBe(
				status === 401 || status === 403 ? "invalid" : "unavailable",
			);
		},
	);
	it.each([
		Response.json({ ...marker, object: "other" }),
		Response.json({ ...marker, schema_version: 2 }),
		Response.json({ ...marker, billing_scope: "account" }),
		Response.json([]),
		new Response(JSON.stringify(marker), {
			headers: { "Content-Type": "text/plain" },
		}),
		new Response("not JSON", {
			headers: { "Content-Type": "application/json" },
		}),
		new Response(new Uint8Array([0xff]), {
			headers: { "Content-Type": "application/json" },
		}),
		new Response(JSON.stringify({ ...marker, detail: "x".repeat(16_384) }), {
			headers: { "Content-Type": "application/json" },
		}),
	])(
		"fails closed on malformed or oversized billing content",
		async (response) => {
			await expect(validator(async () => response)(key)).resolves.toBe(
				"unavailable",
			);
		},
	);
	it("refuses redirected responses and foreign profiles before sending a Key", async () => {
		const response = Response.json(marker);
		Object.defineProperty(response, "url", {
			value: "https://other.invalid/billing",
		});
		await expect(validator(async () => response)(key)).resolves.toBe(
			"unavailable",
		);
		const fetch = vi.fn(async () => Response.json(marker));
		await expect(
			createPersonalRelayKeyValidatorV1({
				profile: "sub2api-key-billing-v1",
				billingUrl: "https://other.invalid/billing",
				fetch,
			})(key),
		).resolves.toBe("unavailable");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("bounds non-cooperative fetch and body reads and sanitizes network/TLS failures", async () => {
		await expect(
			validator(async () => new Promise<Response>(() => {}), 10)(key),
		).resolves.toBe("unavailable");
		await expect(
			validator(
				async () =>
					new Response(
						new ReadableStream({ pull: () => new Promise<void>(() => {}) }),
						{ headers: { "Content-Type": "application/json" } },
					),
				10,
			)(key),
		).resolves.toBe("unavailable");
		await expect(
			validator(async () => {
				throw new Error(key);
			})(key),
		).resolves.toBe("unavailable");
	});
	it("rejects invalid Keys and invalid timeout config before transport", async () => {
		const fetch = vi.fn(async () => Response.json(marker));
		await expect(validator(fetch)("bad\nkey")).resolves.toBe("invalid");
		for (const timeout of [0, Number.NaN, Number.POSITIVE_INFINITY, 10_001])
			await expect(validator(fetch, timeout)(key)).resolves.toBe("unavailable");
		expect(fetch).not.toHaveBeenCalled();
	});
});
