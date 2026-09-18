import { type KeyObject, randomUUID } from "node:crypto";
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

type HopStore = {
	prepare(input: {
		assertionHash: string;
		callId: string;
		dispatchId: string;
		effect: "READ" | "WRITE";
		effectDispatchId?: string;
		hopId: string;
		jti: string;
		leaseProofHash: string;
	}): Promise<void>;
	admit(input: {
		assertionHash: string;
		dispatchId: string;
		hopId: string;
		jti: string;
		leaseProofHash: string;
	}): Promise<"ACCEPTED_NOW" | "REJECTED" | "REPLAYED">;
};

export type ProviderEgressAssertionIssuerOptions = {
	environment: string;
	issuer: string;
	key: { id: string; privateKey: KeyObject };
	now?: () => number;
	store: Pick<HopStore, "prepare">;
};

export function createProviderEgressAssertionIssuer(
	options: ProviderEgressAssertionIssuerOptions,
) {
	return async (input: {
		actionVersionId: string;
		callId: string;
		certificateThumbprint: string;
		connectionId: string;
		credential: string;
		credentialVersionId: string;
		effect: "READ" | "WRITE";
		effectId?: string;
		effectDispatchId?: string;
		plan: ProviderRequestPlanV1;
		providerReleaseId: string;
		recoveryGeneration: string;
	}) => {
		const issuedAt = Math.floor((options.now?.() ?? Date.now()) / 1000);
		const dispatchId = `egress-dispatch-${randomUUID()}`;
		const hopId = `egress-hop-${randomUUID()}`;
		const jti = `egress-jti-${randomUUID()}`;
		const leaseProofHash = sha256(`egress-lease-${randomUUID()}`);
		const claims: DispatchAssertionClaimsV1 = {
			actionVersionId: input.actionVersionId,
			audience: "connection-provider-egress",
			callId: input.callId,
			certificateThumbprint: input.certificateThumbprint,
			connectionId: input.connectionId,
			credentialHash: sha256(input.credential),
			credentialVersionId: input.credentialVersionId,
			dispatchId,
			effect: input.effect,
			effectId: input.effectId ?? null,
			environment: options.environment,
			expiresAt: issuedAt + 30,
			hopId,
			issuedAt,
			issuer: options.issuer,
			jti,
			leaseProofHash,
			method: input.plan.method,
			notBefore: issuedAt - 1,
			origin: input.plan.origin,
			pathTemplate: input.plan.path,
			providerReleaseId: input.providerReleaseId,
			recoveryGeneration: input.recoveryGeneration,
			requestHash: sha256(canonicalJsonV1(input.plan)),
			version: 1,
		};
		const assertion = signEnvelopeV1(
			claims as unknown as JsonValue,
			options.key.id,
			options.key.privateKey,
		);
		await options.store.prepare({
			assertionHash: sha256(canonicalJsonV1(assertion)),
			callId: input.callId,
			dispatchId,
			effect: input.effect,
			...(input.effectDispatchId
				? { effectDispatchId: input.effectDispatchId }
				: {}),
			hopId,
			jti,
			leaseProofHash,
		});
		return { assertion, credential: input.credential, plan: input.plan };
	};
}

export function createProviderEgressAdmissionApp(input: {
	authenticateEgress(request: Request): Promise<{ serviceId: string }>;
	expectedServiceId: string;
	store: Pick<HopStore, "admit">;
}) {
	const app = new Hono();
	app.post("/internal/provider-egress/admissions", async (context) => {
		try {
			const identity = await input.authenticateEgress(context.req.raw);
			if (identity.serviceId !== input.expectedServiceId) {
				return context.json({ error: "EGRESS_IDENTITY_REJECTED" }, 403);
			}
			const body = (await context.req.json()) as {
				assertionHash: string;
				dispatchId: string;
				hopId: string;
				jti: string;
				leaseProofHash: string;
			};
			if (
				Object.keys(body).sort().join(",") !==
					"assertionHash,dispatchId,hopId,jti,leaseProofHash" ||
				Object.values(body).some(
					(value) => typeof value !== "string" || !value || value.length > 256,
				)
			) {
				return context.json({ error: "ADMISSION_REQUEST_INVALID" }, 400);
			}
			return context.json({ admission: await input.store.admit(body) });
		} catch {
			return context.json({ error: "ADMISSION_REQUEST_REJECTED" }, 400);
		}
	});
	return app;
}

export function verifyProviderEgressReceipt(input: {
	dispatchId: string;
	envelope: SignedEnvelopeV1;
	hopId: string;
	jti: string;
	publicKey: KeyObject;
}) {
	const value = verifyEnvelopeV1(input.envelope, input.publicKey);
	if (
		!value ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		value.dispatchId !== input.dispatchId ||
		value.hopId !== input.hopId ||
		value.jti !== input.jti ||
		(value.type !== "COMPLETED" && value.type !== "UNKNOWN")
	) {
		throw new Error("Provider Egress receipt binding is invalid");
	}
	return value;
}
