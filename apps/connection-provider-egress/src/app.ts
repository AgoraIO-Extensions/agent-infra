import type { KeyObject } from "node:crypto";
import {
	canonicalJsonV1,
	type DispatchAssertionClaimsV1,
	type JsonValue,
	type ProviderRequestPlanV1,
	type SignedEnvelopeV1,
	sha256,
	signEnvelopeV1,
	verifyEnvelopeV1,
} from "@agent-infra/provider-egress-contracts";
import { Hono } from "hono";

const audience = "connection-provider-egress";
const maxAssertionLifetimeSeconds = 60;
const maxCredentialBytes = 16 * 1024;
const maxDispatchBodyBytes = 64 * 1024;
const maxResponseBytes = 5 * 1024 * 1024;

type DispatchBody = {
	assertion: SignedEnvelopeV1;
	credential: string;
	plan: ProviderRequestPlanV1;
};

export type EgressAdmission = {
	admit(input: {
		assertionHash: string;
		dispatchId: string;
		hopId: string;
		jti: string;
	}): Promise<"ACCEPTED_NOW" | "REJECTED" | "REPLAYED">;
};

export type WorkloadAuthenticator = {
	authenticate(request: Request): Promise<{ certificateThumbprint: string }>;
};

export type ProviderEgressDependencies = {
	admission: EgressAdmission;
	assertionKeys: ReadonlyMap<string, KeyObject>;
	environment: string;
	fetcher?: typeof fetch;
	issuer: string;
	now?: () => number;
	receiptKey: { id: string; privateKey: KeyObject };
	workloadAuthenticator: WorkloadAuthenticator;
};

const githubPolicies = new Map([
	[
		"github.get_current_user@v8",
		{
			method: "GET",
			origin: "https://api.github.com",
			path: "/user",
		},
	],
]);

export function createProviderEgressApp(
	dependencies: ProviderEgressDependencies,
) {
	const app = new Hono();
	app.get("/healthz", (context) =>
		context.json({ service: "connection-provider-egress", status: "ok" }),
	);
	app.post("/v1/dispatch", async (context) => {
		try {
			const workload = await dependencies.workloadAuthenticator.authenticate(
				context.req.raw,
			);
			const body = await readDispatchBody(context.req.raw);
			const key = dependencies.assertionKeys.get(body.assertion?.keyId);
			if (!key) return context.json({ error: "ASSERTION_KEY_UNKNOWN" }, 401);
			const claims = parseClaims(verifyEnvelopeV1(body.assertion, key));
			const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
			validateClaims(claims, workload.certificateThumbprint, dependencies, now);
			validatePlan(body.plan, claims.actionVersionId);
			if (
				typeof body.credential !== "string" ||
				!body.credential ||
				Buffer.byteLength(body.credential) > maxCredentialBytes
			) {
				throw new Error("Dispatch credential is invalid");
			}
			if (claims.requestHash !== sha256(canonicalJsonV1(body.plan))) {
				throw new Error("Dispatch plan hash mismatch");
			}
			if (claims.credentialHash !== sha256(body.credential)) {
				throw new Error("Dispatch credential hash mismatch");
			}
			const assertionHash = sha256(canonicalJsonV1(body.assertion));
			const admission = await dependencies.admission.admit({
				assertionHash,
				dispatchId: claims.dispatchId,
				hopId: claims.hopId,
				jti: claims.jti,
			});
			if (admission !== "ACCEPTED_NOW") {
				return context.json({ admission, error: "DISPATCH_NOT_ADMITTED" }, 409);
			}
			try {
				const response = await (dependencies.fetcher ?? fetch)(
					new URL(body.plan.path, body.plan.origin),
					{
						headers: {
							accept: "application/vnd.github+json",
							authorization: `Bearer ${body.credential}`,
							"user-agent": "connection-provider-egress/1",
						},
						method: body.plan.method,
						redirect: "manual",
					},
				);
				const responseBytes = await readLimitedResponse(response);
				const receipt = signReceipt(dependencies, claims, {
					bodyHash: sha256(responseBytes),
					httpStatus: response.status,
					type: "COMPLETED",
				});
				return context.json({
					body: Buffer.from(responseBytes).toString("base64url"),
					headers: { "content-type": response.headers.get("content-type") },
					receipt,
					status: response.status,
				});
			} catch {
				return context.json(
					{
						error: "PROVIDER_RESPONSE_UNKNOWN",
						receipt: signReceipt(dependencies, claims, { type: "UNKNOWN" }),
					},
					502,
				);
			}
		} catch (error) {
			return context.json(
				{ error: error instanceof Error ? error.message : "Dispatch rejected" },
				400,
			);
		}
	});
	return app;
}

function parseClaims(value: JsonValue): DispatchAssertionClaimsV1 {
	if (!value || Array.isArray(value) || typeof value !== "object") {
		throw new Error("Dispatch assertion payload is invalid");
	}
	const expectedKeys = [
		"actionVersionId",
		"audience",
		"callId",
		"certificateThumbprint",
		"connectionId",
		"credentialHash",
		"credentialVersionId",
		"dispatchId",
		"effect",
		"effectId",
		"environment",
		"expiresAt",
		"hopId",
		"issuedAt",
		"issuer",
		"jti",
		"method",
		"notBefore",
		"origin",
		"pathTemplate",
		"providerReleaseId",
		"recoveryGeneration",
		"requestHash",
		"version",
	];
	if (Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",")) {
		throw new Error("Dispatch assertion claims are invalid");
	}
	return value as unknown as DispatchAssertionClaimsV1;
}

async function readDispatchBody(request: Request): Promise<DispatchBody> {
	const declaredLength = Number(request.headers.get("content-length"));
	if (declaredLength > maxDispatchBodyBytes) {
		throw new Error("Dispatch request is too large");
	}
	if (!request.body) throw new Error("Dispatch request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxDispatchBodyBytes) {
			await reader.cancel();
			throw new Error("Dispatch request is too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as DispatchBody;
}

function validateClaims(
	claims: DispatchAssertionClaimsV1,
	certificateThumbprint: string,
	dependencies: ProviderEgressDependencies,
	now: number,
) {
	if (
		claims.version !== 1 ||
		claims.audience !== audience ||
		claims.issuer !== dependencies.issuer ||
		claims.environment !== dependencies.environment ||
		claims.certificateThumbprint !== certificateThumbprint ||
		claims.notBefore > now ||
		claims.expiresAt < now ||
		claims.issuedAt > now ||
		claims.expiresAt - claims.issuedAt > maxAssertionLifetimeSeconds ||
		!claims.jti ||
		!claims.dispatchId ||
		!claims.hopId ||
		claims.providerReleaseId !== "github-connection-v8" ||
		claims.method !== "GET" ||
		claims.origin !== "https://api.github.com" ||
		claims.pathTemplate !== "/user" ||
		claims.effect !== "READ"
	) {
		throw new Error("Dispatch assertion claims are invalid");
	}
}

function validatePlan(plan: ProviderRequestPlanV1, actionVersionId: string) {
	const policy = githubPolicies.get(actionVersionId);
	if (
		!plan ||
		Object.keys(plan).sort().join(",") !==
			"actionVersionId,method,origin,path,version" ||
		plan.version !== 1 ||
		plan.actionVersionId !== actionVersionId ||
		!policy ||
		plan.origin !== policy.origin ||
		plan.method !== policy.method ||
		plan.path !== policy.path
	) {
		throw new Error("Provider request plan is not allowlisted");
	}
}

async function readLimitedResponse(response: Response) {
	const declaredLength = Number(response.headers.get("content-length"));
	if (declaredLength > maxResponseBytes) {
		throw new Error("Provider response is too large");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxResponseBytes) {
			await reader.cancel();
			throw new Error("Provider response is too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function signReceipt(
	dependencies: ProviderEgressDependencies,
	claims: DispatchAssertionClaimsV1,
	result:
		| { bodyHash: string; httpStatus: number; type: "COMPLETED" }
		| { type: "UNKNOWN" },
) {
	return signEnvelopeV1(
		{
			dispatchId: claims.dispatchId,
			hopId: claims.hopId,
			jti: claims.jti,
			occurredAt: Math.floor((dependencies.now?.() ?? Date.now()) / 1000),
			...result,
			version: 1,
		},
		dependencies.receiptKey.id,
		dependencies.receiptKey.privateKey,
	);
}
