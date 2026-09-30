import { randomBytes } from "node:crypto";
import type { WecomSetupRecordV1 } from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { createWecomCallbackCipherV1 } from "./callback-credentials.js";

const session: WecomSetupRecordV1 = {
	sessionId: "session",
	agentId: "agent",
	actorId: "owner",
	configurationRevision: 1,
	authorizationRevision: "revision",
	stateDigest: "digest",
	expiresAt: new Date().toISOString(),
	status: "verifying",
	kind: "wecom_app",
	botId: null,
	encryptedCredential: null,
};

it("binds callback material to its key and setup authority", () => {
	const cipher = createWecomCallbackCipherV1({
		activeKeyId: "key",
		keys: [{ id: "key", keyBase64: randomBytes(32).toString("base64") }],
	});
	const material = {
		token: "fixture-token",
		encodingAesKey: randomBytes(32).toString("base64").slice(0, 43),
	};
	const encryptedCallback = cipher.encrypt(session, material);
	expect(JSON.stringify(encryptedCallback)).not.toContain(material.token);
	expect(cipher.decrypt({ ...session, encryptedCallback })).toEqual(material);
	for (const changed of [
		{ agentId: "other" },
		{ actorId: "other" },
		{ sessionId: "other" },
		{ configurationRevision: 2 },
		{ authorizationRevision: "other" },
		{ kind: "wecom_bot" as const },
	])
		expect(() =>
			cipher.decrypt({ ...session, ...changed, encryptedCallback }),
		).toThrow("unavailable");
	const other = createWecomCallbackCipherV1({
		activeKeyId: "key",
		keys: [{ id: "key", keyBase64: randomBytes(32).toString("base64") }],
	});
	expect(() => other.decrypt({ ...session, encryptedCallback })).toThrow(
		"unavailable",
	);
	for (const changed of [
		{ iv: "" },
		{ ciphertext: `${encryptedCallback.ciphertext}\n` },
		{ version: 2 },
	])
		expect(() =>
			cipher.decrypt({
				...session,
				encryptedCallback: { ...encryptedCallback, ...changed },
			}),
		).toThrow("unavailable");
});
