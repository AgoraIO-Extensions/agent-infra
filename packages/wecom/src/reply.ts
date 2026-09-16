import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	privateDecrypt,
	publicEncrypt,
	randomBytes,
} from "node:crypto";
import type { WecomScopeV1, WecomSendPortV1 } from "@agent-infra/platform-core";
import type { WecomConfigurationV1 } from "./index.js";
export interface WecomReplyRouteV1 {
	readonly bindingReference: string;
	readonly credentialVersion: string;
	readonly expiresAt: string;
	readonly scope: WecomScopeV1;
	readonly responseUrl?: string;
	readonly recipientId?: string;
	readonly websocket?: {
		readonly connectionId: string;
		readonly requestId: string;
		readonly streamId: string;
	};
}
function replyKeyId(key: ReturnType<typeof createPublicKey>) {
	return createHash("sha256")
		.update(key.export({ type: "spki", format: "der" }))
		.digest("hex");
}
function scopeDigest(scope: WecomScopeV1) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				scope.agentId,
				scope.bindingReference,
				scope.kind,
				scope.senderId,
				scope.peerId,
				scope.conversationType,
				scope.threadId,
			]),
		)
		.digest("hex");
}
export function createWecomReplyEncryptorV1(publicKeyPem: string) {
	const key = createPublicKey(publicKeyPem);
	if (
		key.asymmetricKeyType !== "rsa" ||
		(key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
	)
		throw new Error("Invalid WeCom reply public key");
	const keyId = replyKeyId(key);
	return async (route: WecomReplyRouteV1): Promise<string> => {
		const dek = randomBytes(32);
		const iv = randomBytes(12);
		try {
			const cipher = createCipheriv("aes-256-gcm", dek, iv);
			cipher.setAAD(Buffer.from(`wecom-reply-v1:${keyId}`));
			const ciphertext = Buffer.concat([
				cipher.update(JSON.stringify(route), "utf8"),
				cipher.final(),
			]);
			return JSON.stringify({
				version: 1,
				keyId,
				iv: iv.toString("base64"),
				tag: cipher.getAuthTag().toString("base64"),
				ciphertext: ciphertext.toString("base64"),
				wrapped: publicEncrypt(
					{
						key,
						padding: constants.RSA_PKCS1_OAEP_PADDING,
						oaepHash: "sha256",
					},
					dek,
				).toString("base64"),
			});
		} finally {
			dek.fill(0);
		}
	};
}
export function createWecomReplyDecryptorV1(
	privateKeyPem: string | readonly string[],
) {
	const keys = new Map(
		(typeof privateKeyPem === "string" ? [privateKeyPem] : privateKeyPem).map(
			(pem) => {
				const key = createPrivateKey(pem);
				if (
					key.asymmetricKeyType !== "rsa" ||
					(key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
				)
					throw new Error("Invalid WeCom reply private key");
				return [replyKeyId(createPublicKey(key)), key] as const;
			},
		),
	);
	if (keys.size === 0) throw new Error("Invalid WeCom reply private key");
	return async (handle: string): Promise<WecomReplyRouteV1> => {
		let dek: Buffer | undefined;
		try {
			if (handle.length > 12000) throw new Error();
			const value = JSON.parse(handle);
			if (!value || typeof value !== "object" || value.version !== 1)
				throw new Error();
			const key = keys.get(value.keyId);
			if (!key) throw new Error();
			const decode = (encoded: unknown, expectedLength?: number) => {
				if (typeof encoded !== "string") throw new Error();
				const decoded = Buffer.from(encoded, "base64");
				if (
					decoded.toString("base64") !== encoded ||
					(expectedLength !== undefined && decoded.length !== expectedLength)
				)
					throw new Error();
				return decoded;
			};
			dek = privateDecrypt(
				{ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
				decode(
					value.wrapped,
					(key.asymmetricKeyDetails?.modulusLength ?? 0) / 8,
				),
			);
			if (dek.length !== 32) throw new Error();
			const decipher = createDecipheriv(
				"aes-256-gcm",
				dek,
				decode(value.iv, 12),
			);
			decipher.setAAD(Buffer.from(`wecom-reply-v1:${value.keyId}`));
			decipher.setAuthTag(decode(value.tag, 16));
			return JSON.parse(
				Buffer.concat([
					decipher.update(decode(value.ciphertext)),
					decipher.final(),
				]).toString("utf8"),
			) as WecomReplyRouteV1;
		} catch {
			throw new Error("WeCom reply route is unavailable");
		} finally {
			dek?.fill(0);
		}
	};
}
export function createWecomSenderV1(options: {
	readonly resolveConfiguration: (
		scope: WecomScopeV1,
	) => Promise<WecomConfigurationV1 | null>;
	readonly revealReply: (handle: string) => Promise<WecomReplyRouteV1>;
	readonly getApplicationAccessToken: (
		config: WecomConfigurationV1,
	) => Promise<string>;
	readonly fetch?: typeof fetch;
	readonly now?: () => Date;
}): WecomSendPortV1 {
	return {
		async send(input) {
			let url: string;
			let body: unknown;
			try {
				const config = await options.resolveConfiguration(input.scope);
				const route = await options.revealReply(input.replyHandle);
				if (
					!config ||
					config.bindingReference !== input.scope.bindingReference ||
					config.agentId !== input.scope.agentId ||
					config.kind !== input.scope.kind ||
					scopeDigest(route.scope) !== scopeDigest(input.scope) ||
					route.bindingReference !== config.bindingReference ||
					route.credentialVersion !== config.credentialVersion ||
					!Number.isFinite(Date.parse(route.expiresAt)) ||
					Date.parse(route.expiresAt) <=
						(options.now?.() ?? new Date()).getTime()
				)
					return "failed";
				if (config.kind === "wecom_bot") {
					const target = new URL(route.responseUrl ?? "");
					if (
						target.origin !== "https://qyapi.weixin.qq.com" ||
						target.pathname !== "/cgi-bin/aibot/response" ||
						target.username ||
						target.password ||
						target.hash ||
						!target.searchParams.get("response_code") ||
						Buffer.byteLength(input.text) > 20_480
					)
						return "failed";
					url = target.href;
					body = { msgtype: "markdown", markdown: { content: input.text } };
				} else {
					if (
						!config.applicationId ||
						!/^\d+$/.test(config.applicationId) ||
						route.recipientId !== input.scope.senderId ||
						/[|@]/.test(route.recipientId) ||
						Buffer.byteLength(input.text) > 2048
					)
						return "failed";
					const token = await options.getApplicationAccessToken(config);
					if (!token) return "failed";
					url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;
					body = {
						touser: route.recipientId,
						msgtype: "text",
						agentid: Number(config.applicationId),
						text: { content: input.text },
					};
				}
			} catch {
				return "failed";
			}
			try {
				const response = await (options.fetch ?? fetch)(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) return "unknown";
				const reader = response.body?.getReader();
				if (!reader) return "unknown";
				let size = 0;
				const chunks: Uint8Array[] = [];
				try {
					for (;;) {
						const part = await reader.read();
						if (part.done) break;
						size += part.value.byteLength;
						if (size > 65536) return "unknown";
						chunks.push(part.value);
					}
				} finally {
					await reader.cancel();
				}
				const data = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks),
					),
				) as {
					errcode?: unknown;
					invaliduser?: unknown;
					unlicenseduser?: unknown;
				};
				if (data.errcode === 0 && !data.invaliduser && !data.unlicenseduser)
					return "sent";
				if (
					(typeof data.errcode === "number" && data.errcode !== 0) ||
					data.invaliduser ||
					data.unlicenseduser
				)
					return "failed";
				return "unknown";
			} catch {
				return "unknown";
			}
		},
	};
}
