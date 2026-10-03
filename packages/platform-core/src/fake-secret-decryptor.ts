import type { SecretActivationDecryptorPortV1 } from "./secret-activation.js";

export class FakeSecretActivationDecryptorV1
	implements SecretActivationDecryptorPortV1
{
	readonly #decision:
		| { readonly outcome: "decrypted"; readonly plaintext: Uint8Array }
		| {
				readonly outcome: "failed";
				readonly code:
					| "SECRET_KEY_UNAVAILABLE"
					| "SECRET_METADATA_INVALID"
					| "SECRET_AUTHENTICATION_FAILED";
		  };

	constructor(
		decision:
			| { readonly outcome: "decrypted"; readonly plaintext: Uint8Array }
			| {
					readonly outcome: "failed";
					readonly code:
						| "SECRET_KEY_UNAVAILABLE"
						| "SECRET_METADATA_INVALID"
						| "SECRET_AUTHENTICATION_FAILED";
			  },
	) {
		this.#decision = decision;
	}

	async decrypt() {
		return this.#decision.outcome === "decrypted"
			? {
					outcome: "decrypted" as const,
					plaintext: new Uint8Array(this.#decision.plaintext),
				}
			: { ...this.#decision };
	}
}
