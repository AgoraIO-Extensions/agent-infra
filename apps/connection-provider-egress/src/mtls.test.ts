import { describe, expect, it, vi } from "vitest";

import { createMtlsBoundFetch, mtlsWorkloadAuthenticator } from "./mtls";

function environment(socket: {
	authorized: boolean;
	getPeerCertificate(): { fingerprint256?: string };
}) {
	return { incoming: { socket } } as never;
}

describe("Provider Egress workload mTLS binding", () => {
	it("overwrites spoofed identity with the verified peer certificate", async () => {
		const appFetch = vi.fn(async (request: Request) =>
			Response.json(await mtlsWorkloadAuthenticator.authenticate(request)),
		);
		const response = await createMtlsBoundFetch(appFetch)(
			new Request("https://egress.example/v1/dispatch", {
				headers: {
					"x-connection-verified-client-thumbprint": "sha256:spoofed",
				},
			}),
			environment({
				authorized: true,
				getPeerCertificate: () => ({ fingerprint256: "AA:BB:CC" }),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			certificateThumbprint: "sha256:aabbcc",
		});
	});

	it("rejects unauthorized or certificate-less peers before the app", async () => {
		const appFetch = vi.fn(async () => new Response("unexpected"));
		for (const socket of [
			{
				authorized: false,
				getPeerCertificate: () => ({ fingerprint256: "AA:BB" }),
			},
			{ authorized: true, getPeerCertificate: () => ({}) },
		]) {
			const response = await createMtlsBoundFetch(appFetch)(
				new Request("https://egress.example/v1/dispatch"),
				environment(socket),
			);
			expect(response.status).toBe(401);
		}
		expect(appFetch).not.toHaveBeenCalled();
	});
});
