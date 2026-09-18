import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJsonV1, signEnvelopeV1, verifyEnvelopeV1 } from "./index";

describe("Provider Egress contracts", () => {
	it("canonicalizes recursively and verifies Ed25519 envelopes", () => {
		const keys = generateKeyPairSync("ed25519");
		const payload = { b: 2, a: { d: 4, c: 3 } };
		expect(canonicalJsonV1(payload)).toBe('{"a":{"c":3,"d":4},"b":2}');
		expect(
			verifyEnvelopeV1(
				signEnvelopeV1(payload, "key-1", keys.privateKey),
				keys.publicKey,
			),
		).toEqual(payload);
	});

	it("rejects non-finite numbers and tampered signatures", () => {
		const keys = generateKeyPairSync("ed25519");
		expect(() => canonicalJsonV1(Number.NaN)).toThrow(/non-finite/);
		const envelope = signEnvelopeV1({ ok: true }, "key-1", keys.privateKey);
		envelope.signature = `${envelope.signature[0] === "A" ? "B" : "A"}${envelope.signature.slice(1)}`;
		expect(() => verifyEnvelopeV1(envelope, keys.publicKey)).toThrow(
			/verification/,
		);
	});
});
