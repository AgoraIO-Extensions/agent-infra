import { createCipheriv, createHash } from "node:crypto";
import type { WecomConfigurationV1 } from "./index.js";
/** Controlled provider fixture using the published WeCom envelope. No real credentials. */
export function wecomCallbackFixtureV1(
	config: WecomConfigurationV1,
	payload: unknown,
	now: Date,
): Request {
	const text = typeof payload === "string" ? payload : JSON.stringify(payload);
	const message = Buffer.from(text);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(message.length);
	const receiver =
		config.kind === "wecom_bot" ? "" : (config.corporationId ?? "");
	const plain = Buffer.concat([
		Buffer.alloc(16, 3),
		length,
		message,
		Buffer.from(receiver),
	]);
	const pad = 32 - (plain.length % 32);
	const key = Buffer.from(`${config.encodingAesKey}=`, "base64");
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	cipher.setAutoPadding(false);
	const encrypt = Buffer.concat([
		cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
		cipher.final(),
	]).toString("base64");
	const timestamp = String(Math.floor(now.getTime() / 1000));
	const nonce = "fixture-nonce";
	const signature = createHash("sha1")
		.update([config.token, timestamp, nonce, encrypt].sort().join(""))
		.digest("hex");
	return new Request(
		`https://platform.test/callbacks/wecom/${config.bindingReference}?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${signature}`,
		{
			method: "POST",
			body:
				config.kind === "wecom_bot"
					? JSON.stringify({ encrypt })
					: `<xml><Encrypt>${encrypt}</Encrypt></xml>`,
		},
	);
}
