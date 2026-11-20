import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readSessionReserveInstanceV1 } from "./session-reserve-instance.js";

const worker = generateKeyPairSync("ed25519");
const host = generateKeyPairSync("ed25519");
const hostPublicKey = host.publicKey
	.export({ format: "der", type: "spki" })
	.toString("base64url");
function fixture(
	change: (proof: Record<string, unknown>) => void = () => {},
	malformed = false,
) {
	const now = 1900000000000;
	const revalidate = vi.fn(async () => {});
	const binding = {
		schemaVersion: 1 as const,
		workerId: "worker",
		namespace: "reserve",
		agentId: "agent",
		sessionId: "session",
		sandboxId: "sandbox",
		podUid: "pod",
		generation: 1,
		resourceFence: 1,
		startupRef: "executor-v2-ref",
		bindingDigest: "a".repeat(64),
		profileDigest: "b".repeat(64),
		scope: {
			phase: "reserve" as const,
			reserveRef: "reserve:sandbox",
			reserveDeliveryFence: 2,
		},
	};
	const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
		const { authorization, ...request } = JSON.parse(init!.body as string);
		const claims = JSON.parse(
			Buffer.from(authorization.split(".")[1], "base64url").toString(),
		);
		const proof = {
			...request,
			requestDigest: claims.requestDigest,
			hostKeyId: "host-key",
			runnerEpoch: "123e4567-e89b-42d3-a456-426614174099",
			observedAt: now,
			expiresAt: now + 5000,
			checks: {
				hostIdentityConsumed: true,
				runnerIdentityConsumed: true,
				deliveryFilesRemoved: true,
				executorReady: true,
				emptyBusinessState: true,
			},
		};
		change(proof);
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: "host-key",
				typ: "session-instance-evidence-v1",
			}),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				...proof,
				purpose: "session-instance-evidence-v1",
				audience: "worker",
			}),
		).toString("base64url");
		const bytes = `${header}.${payload}`;
		const signature = `${bytes}.${sign(null, Buffer.from(bytes), malformed ? worker.privateKey : host.privateKey).toString("base64url")}`;
		return new Response(JSON.stringify({ ...proof, signature }), {
			headers: { "content-type": "application/json" },
		});
	});
	const options = {
		binding,
		hostKeyId: "host-key",
		hostPublicKey,
		expectedRunnerEpoch: "123e4567-e89b-42d3-a456-426614174099",
		serviceToken: "synthetic-derived-sandbox-token-123456789",
		origin: "http://sandbox-sandbox.reserve.svc:8080/",
		signing: {
			workerId: "worker",
			issuer: "platform",
			keyId: "worker-key",
			privateKey: worker.privateKey,
		},
		fetch: fetcher,
		now: () => now,
		revalidate,
	};
	return { options, fetcher, revalidate };
}
it("accepts only a fresh original Host signature and revalidates actual resources after the read", async () => {
	const f = fixture();
	expect(await readSessionReserveInstanceV1(f.options)).toMatchObject({
		podUid: "pod",
		hostKeyId: "host-key",
		resourceFence: 1,
		scope: f.options.binding.scope,
	});
	expect(f.revalidate).toHaveBeenCalledTimes(2);
	const call = f.fetcher.mock.calls[0]!;
	expect(String(call[0])).toBe(
		"http://sandbox-sandbox.reserve.svc:8080/internal/runtime/v1/session-instance/read",
	);
	expect(call[1]?.redirect).toBe("error");
	expect(JSON.stringify(call[1])).not.toContain("PRIVATE_CANARY");
});
it.each([
	"nonce",
	"podUid",
	"agentId",
	"sessionId",
	"sandboxId",
	"profileDigest",
	"bindingDigest",
	"workerId",
	"resourceFence",
	"runnerEpoch",
	"expiresAt",
	"observedAt",
	"scope",
	"checks",
	"signature",
])("refuses %s drift and never returns ready evidence", async (field) => {
	const f = fixture((proof) => {
		if (field === "checks")
			proof.checks = { ...(proof.checks as object), emptyBusinessState: false };
		else if (field === "expiresAt") proof.expiresAt = 1900000000000;
		else if (field === "observedAt") proof.observedAt = 1900000000010;
		else if (field === "scope")
			proof.scope = {
				phase: "claimed",
				claimRef: "foreign",
				allocationRef: "foreign",
			};
		else if (field === "runnerEpoch")
			proof.runnerEpoch = "123e4567-e89b-42d3-a456-426614174098";
		else if (field !== "signature") proof[field] = "foreign";
	}, field === "signature");
	expect(await readSessionReserveInstanceV1(f.options)).toBeNull();
});
