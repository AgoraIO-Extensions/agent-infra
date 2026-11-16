import { expect, it, vi } from "vitest";
import { createConnectionAssociationVerifierV1 } from "./connection-association-verifier.ts";

const credential = "SYNTHETIC_CONNECTION_SERVICE_CREDENTIAL";
const origin = "https://connection.example.test";
const input = {
	connectionAgentId: "connection-agent-01",
	serviceCredential: credential,
};
const target = `${origin}/connection/v1/agents/connection-agent-01/actions`;

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function verifier(response: () => Response | Promise<Response>) {
	const fetch = vi.fn(async (_request: Request) => response());
	return {
		fetch,
		verify: createConnectionAssociationVerifierV1({
			publicOrigin: origin,
			fetch: fetch as unknown as typeof globalThis.fetch,
		}),
	};
}

it("calls the read-only actions endpoint once with the submitted credential only", async () => {
	const f = verifier(() => json(200, { actions: [] }));
	expect(await f.verify(input, new AbortController().signal)).toBe("verified");
	expect(f.fetch).toHaveBeenCalledTimes(1);
	const request = f.fetch.mock.calls[0]?.[0] as Request;
	expect(request.method).toBe("GET");
	expect(request.url).toBe(target);
	expect(request.redirect).toBe("error");
	expect(request.headers.get("authorization")).toBe(`Bearer ${credential}`);
	expect(request.headers.has("cookie")).toBe(false);
	expect(request.body).toBeNull();
});

it("rejects an echoed identity of another Connection Agent", async () => {
	const f = verifier(() => json(200, { agentId: "connection-agent-02" }));
	expect(await f.verify(input, new AbortController().signal)).toBe(
		"credential_rejected",
	);
	const g = verifier(() =>
		json(200, { consumer: { consumerId: "connection-agent-01" } }),
	);
	expect(await g.verify(input, new AbortController().signal)).toBe("verified");
});

it.each([
	[401, { error: { code: "AUTHENTICATION_REQUIRED" } }, "credential_rejected"],
	[403, { error: { code: "FORBIDDEN" } }, "credential_rejected"],
	[404, { error: { code: "NOT_FOUND" } }, "credential_rejected"],
	[403, { error: { code: "CONSUMER_DISABLED" } }, "consumer_unavailable"],
	[409, { error: { code: "CONFLICT" } }, "consumer_unavailable"],
	[500, { error: { code: "INTERNAL" } }, "unknown"],
	[503, {}, "unknown"],
] as const)("maps HTTP %i %j to %s", async (status, body, expected) => {
	const f = verifier(() => json(status, body));
	expect(await f.verify(input, new AbortController().signal)).toBe(expected);
});

it("treats transport failures, redirects and non-JSON success as unknown", async () => {
	for (const response of [
		() => Promise.reject(new Error(`boom ${credential}`)),
		() =>
			new Response("ok", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		() => {
			const redirected = json(200, {});
			Object.defineProperty(redirected, "redirected", { value: true });
			return redirected;
		},
	]) {
		const f = verifier(response);
		expect(await f.verify(input, new AbortController().signal)).toBe("unknown");
	}
});

it("requires an HTTPS origin without path", () => {
	for (const publicOrigin of [
		"http://connection.example.test",
		"https://connection.example.test/base",
	])
		expect(() =>
			createConnectionAssociationVerifierV1({ publicOrigin }),
		).toThrow();
});
