import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";
import { describe, expect, it } from "vitest";
import { runtimeV4Harness, signingKeys } from "./test-support/runtime-v4.js";

const verify = createRuntimeExecutionGrantVerifierV2(
	new Map([["signing", signingKeys.publicKey]]),
);
function custom(h: ReturnType<typeof runtimeV4Harness>) {
	for (const version of [h.workload.candidate, h.workload.verified]) {
		if (!version) throw new Error("Missing fixture Workload version");
		Object.assign(version.configuration, {
			source: { kind: "custom", interactionMode: "platform-adapter" },
		});
	}
	Object.assign(h.workload, {
		capabilities: { supplementaryInstruction: true },
	});
	Object.assign(h.claim, {
		modelConfigurationRevision: null,
		modelOptionId: null,
		reasoningLevel: null,
		executionSource: null,
		relayKeyBinding: null,
	});
	Object.assign(h.state, { runtimeSubmitProtocol: "v2" });
	h.setAccepted(null);
}

describe("trusted custom platform adapter business delivery", () => {
	it.each(["submit", "supplement"] as const)(
		"preserves %s on the original V3 path without platform Key delivery",
		async (operation) => {
			const h = runtimeV4Harness(operation);
			try {
				custom(h);
				const reference = await h.authorize();
				const response = await h.runtime.runtimeHost.dispatch({
					...h.request(reference),
					input: { text: "caller replacement", attachments: [] },
				});
				const { body, url } = h.sent();
				expect(url).toContain(
					operation === "submit" ? "/v3/turns" : "/v3/instructions",
				);
				expect(response).toMatchObject({ schemaVersion: 1 });
				expect(body).toMatchObject({
					schemaVersion: 3,
					executionId: "execution",
					turnId: "turn",
					sessionGeneration: 1,
					hostSessionRef: "host",
					input: { text: "original accepted input", attachments: [] },
				});
				expect(verify(body.grant).claims).toMatchObject({
					purpose: "business",
					authorizationRecordId: "authorization",
					allowedCommands: [
						operation === "submit" ? "turn.submit" : "turn.supplement",
					],
				});
				expect(body).not.toHaveProperty("selection");
				expect(body).not.toHaveProperty("privateKeyField");
				expect(h.executionKeys.readAcceptedExecution).not.toHaveBeenCalled();
				expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
				expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);

	it.each(["v4", "key", "execution-source", "self-managed"] as const)(
		"rejects custom %s contamination before business dispatch",
		async (mutation) => {
			const h = runtimeV4Harness();
			try {
				const binding = h.claim.relayKeyBinding;
				custom(h);
				if (mutation === "v4")
					Object.assign(h.state, { runtimeSubmitProtocol: "v4" });
				if (mutation === "key")
					Object.assign(h.claim, { relayKeyBinding: binding });
				if (mutation === "execution-source")
					Object.assign(h.claim, { executionSource: "web" });
				if (mutation === "self-managed")
					Object.assign(h.workload.candidate.configuration.source, {
						interactionMode: "self-managed",
					});
				const reference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toThrow();
				expect(h.fetcher).not.toHaveBeenCalled();
				expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
				expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);

	it("keeps standard missing-Key admission closed instead of selecting custom", async () => {
		const h = runtimeV4Harness();
		try {
			Object.assign(h.claim, { executionSource: null, relayKeyBinding: null });
			Object.assign(h.state, { runtimeSubmitProtocol: "v2" });
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toMatchObject({ code: "RELAY_KEY_UNAVAILABLE" });
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});
});
