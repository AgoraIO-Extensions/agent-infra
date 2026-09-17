import { randomBytes } from "node:crypto";
import type { WecomSetupRecordV1 } from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { createWecomCallbackCipherV1 } from "./callback-credentials.js";

const session: WecomSetupRecordV1 = {
	sessionId: "s",
	agentId: "a",
	actorId: "u",
	configurationRevision: 1,
	authorizationRevision: "r",
	stateDigest: "d",
	expiresAt: new Date().toISOString(),
	status: "verifying",
	kind: "wecom_app",
	botId: null,
	encryptedCredential: null,
};
it("isolates callback ciphertext by key, Agent, Owner, session and revision", () => {
	const keys = {
		activeKeyId: "key",
		keys: [{ id: "key", keyBase64: randomBytes(32).toString("base64") }],
	};
	const cipher = createWecomCallbackCipherV1(keys);
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
	])
		expect(() =>
			cipher.decrypt({ ...session, ...changed, encryptedCallback }),
		).toThrow("unavailable");
	expect(() =>
		cipher.decrypt({ ...session, kind: "wecom_bot", encryptedCallback }),
	).toThrow("unavailable");
	const other = createWecomCallbackCipherV1({
		activeKeyId: "key",
		keys: [{ id: "key", keyBase64: randomBytes(32).toString("base64") }],
	});
	expect(() => other.decrypt({ ...session, encryptedCallback })).toThrow(
		"unavailable",
	);
	for (const changed of [
		{
			tag: Buffer.from(encryptedCallback.tag, "base64")
				.subarray(0, 12)
				.toString("base64"),
		},
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
	expect(() =>
		cipher.decrypt({
			...session,
			encryptedCallback: { crypto: { wrappingKeyVersion: "key" } },
		}),
	).toThrow("unavailable");
});
