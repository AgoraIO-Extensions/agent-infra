import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createProviderEgressApp, type ProviderRequestPlanV1 } from "./app";
import {
	canonicalJsonV1,
	sha256,
	signEnvelopeV1,
	verifyEnvelopeV1,
} from "./protocol";

const nowSeconds = 1_800_000_000;
const assertionKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");
const plan: ProviderRequestPlanV1 = {
	actionVersionId: "github.get_current_user@v8",
	method: "GET",
	origin: "https://api.github.com",
	path: "/user",
	version: 1,
};
const credential = "github-token";

function assertion(overrides: Record<string, unknown> = {}) {
	return signEnvelopeV1(
		{
			actionVersionId: plan.actionVersionId,
			audience: "connection-provider-egress",
			certificateThumbprint: "sha256:workload-cert",
			credentialHash: sha256(credential),
			dispatchId: "dispatch-1",
			effect: "READ",
			environment: "test",
			expiresAt: nowSeconds + 30,
			hopId: "hop-1",
			issuedAt: nowSeconds,
			issuer: "connection-control-plane",
			jti: "jti-1",
			notBefore: nowSeconds - 1,
			planHash: sha256(canonicalJsonV1(plan)),
			providerReleaseId: "github-connection-v8",
			version: 1,
			...overrides,
		},
		"assertion-key-1",
		assertionKeys.privateKey,
	);
}

function requestBody(overrides: Record<string, unknown> = {}) {
	return {
		assertion: assertion(),
		credential,
		plan,
		...overrides,
	};
}

function fixture() {
	const consumed = new Set<string>();
	const fetcher = vi.fn<typeof fetch>(async () =>
		Response.json({ id: 7, login: "alice" }),
	);
	const app = createProviderEgressApp({
		admission: {
			admit: async ({ jti }) => {
				if (consumed.has(jti)) return "REPLAYED";
				consumed.add(jti);
				return "ACCEPTED_NOW";
			},
		},
		assertionKeys: new Map([["assertion-key-1", assertionKeys.publicKey]]),
		environment: "test",
		fetcher,
		issuer: "connection-control-plane",
		now: () => nowSeconds * 1000,
		receiptKey: { id: "receipt-key-1", privateKey: receiptKeys.privateKey },
		workloadAuthenticator: {
			authenticate: async () => ({
				certificateThumbprint: "sha256:workload-cert",
			}),
		},
	});
	return { app, fetcher };
}

async function dispatch(
	app: ReturnType<typeof createProviderEgressApp>,
	body: unknown,
) {
	return app.request("/v1/dispatch", {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
}

describe("Connection Provider Egress", () => {
	it("admits once, executes one allowlisted GitHub request, and signs a receipt", async () => {
		const { app, fetcher } = fixture();
		const response = await dispatch(app, requestBody());
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(fetcher).toHaveBeenCalledOnce();
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/user",
		);
		expect(result.status).toBe(200);
		expect(
			verifyEnvelopeV1(result.receipt, receiptKeys.publicKey),
		).toMatchObject({ dispatchId: "dispatch-1", type: "COMPLETED" });

		const replay = await dispatch(app, requestBody());
		expect(replay.status).toBe(409);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("rejects tampered, expired, wrong-workload, and non-allowlisted dispatches before fetch", async () => {
		for (const body of [
			{ ...requestBody(), credential: "tampered-token" },
			{ ...requestBody(), assertion: assertion({ expiresAt: nowSeconds - 1 }) },
			{
				...requestBody(),
				assertion: assertion({ certificateThumbprint: "sha256:other-cert" }),
			},
			{
				...requestBody(),
				plan: { ...plan, origin: "https://attacker.example" },
			},
			{
				...requestBody(),
				plan: { ...plan, headers: { "x-forwarded-host": "attacker.example" } },
			},
		]) {
			const { app, fetcher } = fixture();
			const response = await dispatch(app, body);
			expect(response.status).toBe(400);
			expect(fetcher).not.toHaveBeenCalled();
		}
	});

	it("rejects oversized dispatch bodies before admission", async () => {
		const { app, fetcher } = fixture();
		const response = await dispatch(app, {
			...requestBody(),
			padding: "x".repeat(70 * 1024),
		});
		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("returns a signed UNKNOWN receipt after admission when Provider response is lost", async () => {
		const { app } = fixture();
		const failedApp = createProviderEgressApp({
			admission: { admit: async () => "ACCEPTED_NOW" },
			assertionKeys: new Map([["assertion-key-1", assertionKeys.publicKey]]),
			environment: "test",
			fetcher: async () => {
				throw new TypeError("offline");
			},
			issuer: "connection-control-plane",
			now: () => nowSeconds * 1000,
			receiptKey: { id: "receipt-key-1", privateKey: receiptKeys.privateKey },
			workloadAuthenticator: {
				authenticate: async () => ({
					certificateThumbprint: "sha256:workload-cert",
				}),
			},
		});
		expect(app).toBeTruthy();
		const response = await dispatch(failedApp, requestBody());
		expect(response.status).toBe(502);
		const result = await response.json();
		expect(
			verifyEnvelopeV1(result.receipt, receiptKeys.publicKey),
		).toMatchObject({ type: "UNKNOWN" });
	});
});

describe("Provider Egress canonicalization", () => {
	it("sorts object keys recursively and rejects non-finite numbers", () => {
		expect(canonicalJsonV1({ b: 2, a: { d: 4, c: 3 } })).toBe(
			'{"a":{"c":3,"d":4},"b":2}',
		);
		expect(() => canonicalJsonV1(Number.NaN)).toThrow(/non-finite/);
	});
});
