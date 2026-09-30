import { describe, expect, it, vi } from "vitest";

import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

const key = "synthetic-personal-relay-key";
const url = "https://sub2api.la3.agoralab.co/v1/sub2api/billing";
const billing = {
	object: "sub2api.key_billing",
	schema_version: 1,
	billing_scope: "token",
	group_rate_multiplier: 1,
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function validator(
	fetcher: typeof fetch,
	options: {
		readonly billingUrl?: string;
		readonly profile?: string;
		readonly timeoutMs?: number;
	} = {},
) {
	return createPersonalRelayKeyValidatorV1({
		profile: (options.profile ??
			"sub2api-key-billing-v1") as "sub2api-key-billing-v1",
		billingUrl: options.billingUrl ?? url,
		fetch: fetcher,
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
}

describe("personal Relay Key read-only authentication", () => {
	it("requires the billing profile from the fixed TLS route", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => json(billing));
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
		"classifies billing authentication or permission status %i as invalid",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>(async () =>
				json({ error: "denied" }, status),
			);
			await expect(validator(fetcher)(key)).resolves.toBe("invalid");
		},
	);

	it.each([201, 302, 404, 429, 500, 503])(
		"treats other billing status %i as unavailable",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>(
				async () => new Response(null, { status }),
			);
			await expect(validator(fetcher)(key)).resolves.toBe("unavailable");
		},
	);

	it.each([
		json({ ...billing, object: "list" }),
		json({ ...billing, schema_version: 2 }),
		json({ ...billing, billing_scope: "user" }),
		json({ object: "sub2api.key_billing", schema_version: 1 }),
		json({ data: [{ id: "model-a" }] }),
		new Response("not json", {
			headers: { "content-type": "application/json" },
		}),
		new Response("<html>ok</html>", {
			headers: { "content-type": "text/html" },
		}),
		new Response("x".repeat(16_385), {
			headers: { "content-type": "application/json" },
		}),
	])("rejects an unknown or malformed billing response", async (response) => {
		const fetcher = vi.fn<typeof fetch>(async () => response);
		await expect(validator(fetcher)(key)).resolves.toBe("unavailable");
	});

	it("never sends the Key to an unapproved profile or URL", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => json(billing));
		await expect(
			validator(fetcher, { profile: "sub2api-v1-model-list" })(key),
		).resolves.toBe("unavailable");
		await expect(
			validator(fetcher, {
				billingUrl: "https://relay.example.test/v1/sub2api/billing",
			})(key),
		).resolves.toBe("unavailable");
		await expect(
			validator(fetcher, {
				billingUrl: "http://sub2api.la3.agoralab.co/v1/sub2api/billing",
			})(key),
		).resolves.toBe("unavailable");
		await expect(
			validator(fetcher, { billingUrl: `${url}?key=${key}` })(key),
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
			Response.redirect("https://other.example.test/billing", 302),
		);
		await expect(validator(redirected)(key)).resolves.toBe("unavailable");
		const hanging = vi.fn<typeof fetch>(
			async (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error(key)),
						{ once: true },
					);
				}),
		);
		await expect(validator(hanging, { timeoutMs: 5 })(key)).resolves.toBe(
			"unavailable",
		);
	});
});
