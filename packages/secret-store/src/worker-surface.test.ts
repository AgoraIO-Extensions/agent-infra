import { describe, expect, it } from "vitest";
import * as workerSecretStore from "./worker.js";

describe("Worker-only Secret Store surface", () => {
	it("exposes keyring operations separately from the encrypt-only main entry", () => {
		expect(Object.keys(workerSecretStore).toSorted()).toEqual([
			"createSecretKeyRotationCryptoV1",
			"createSecretKeyringDecryptorV1",
		]);
	});
});
