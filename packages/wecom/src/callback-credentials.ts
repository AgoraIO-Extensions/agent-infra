import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { WecomSetupRecordV1 } from "@agent-infra/platform-core";

export interface WecomCallbackKeysV1 {
	readonly activeKeyId: string;
	readonly keys: readonly { readonly id: string; readonly keyBase64: string }[];
}
/** API-only keys, distinct from the RSA keyrings for sending and reply routes. */
export function createWecomCallbackCipherV1(
	configuration: WecomCallbackKeysV1,
) {
	const keys = new Map<string, Buffer>();
	for (const entry of configuration.keys) {
		const key = Buffer.from(entry.keyBase64, "base64");
		if (
			!/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ||
			keys.has(entry.id) ||
			key.length !== 32 ||
			key.toString("base64") !== entry.keyBase64
		)
			throw new Error("Invalid WeCom callback keyring");
		keys.set(entry.id, key);
	}
	if (!keys.has(configuration.activeKeyId))
		throw new Error("Invalid WeCom callback keyring");
	const aad = (session: WecomSetupRecordV1, keyId: string) =>
		Buffer.from(
			JSON.stringify([
				"wecom-app-callback-v1",
				session.kind,
				keyId,
				session.sessionId,
				session.agentId,
				session.actorId,
				session.configurationRevision,
			]),
		);
	return {
		hasKey: (id: string) => keys.has(id),
		encrypt(
			session: WecomSetupRecordV1,
			material: { token: string; encodingAesKey: string },
		) {
			if (session.kind !== "wecom_app")
				throw new Error("Invalid WeCom callback purpose");
			const keyId = configuration.activeKeyId;
			const iv = randomBytes(12);
			const active = keys.get(keyId);
			if (!active) throw new Error("Invalid WeCom callback keyring");
			const cipher = createCipheriv("aes-256-gcm", active, iv);
			cipher.setAAD(aad(session, keyId));
			const ciphertext = Buffer.concat([
				cipher.update(JSON.stringify(material), "utf8"),
				cipher.final(),
			]);
			return {
				version: 1,
				keyId,
				iv: iv.toString("base64"),
				tag: cipher.getAuthTag().toString("base64"),
				ciphertext: ciphertext.toString("base64"),
			};
		},
		decrypt(session: WecomSetupRecordV1) {
			if (session.kind !== "wecom_app")
				throw new Error("WeCom callback credential unavailable");
			let plaintext: Buffer | undefined;
			try {
				const value = session.encryptedCallback as Record<string, unknown>;
				if (value?.version !== 1 || typeof value.keyId !== "string")
					throw new Error();
				const key = keys.get(value.keyId);
				if (!key) throw new Error();
				const decode = (input: unknown, length?: number) => {
					if (typeof input !== "string" || input.length > 8192)
						throw new Error();
					const bytes = Buffer.from(input, "base64");
					if (
						bytes.toString("base64") !== input ||
						(length !== undefined && bytes.length !== length)
					)
						throw new Error();
					return bytes;
				};
				const decipher = createDecipheriv(
					"aes-256-gcm",
					key,
					decode(value.iv, 12),
				);
				decipher.setAAD(aad(session, value.keyId));
				decipher.setAuthTag(decode(value.tag, 16));
				plaintext = Buffer.concat([
					decipher.update(decode(value.ciphertext)),
					decipher.final(),
				]);
				const material = JSON.parse(plaintext.toString("utf8"));
				if (
					typeof material.token !== "string" ||
					!material.token ||
					!/^[A-Za-z0-9+/]{43}$/.test(material.encodingAesKey) ||
					Object.keys(material).length !== 2
				)
					throw new Error();
				return {
					token: material.token as string,
					encodingAesKey: material.encodingAesKey as string,
				};
			} catch {
				throw new Error("WeCom callback credential unavailable");
			} finally {
				plaintext?.fill(0);
			}
		},
	};
}
