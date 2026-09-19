import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { WecomMessageV1, WecomScopeV1 } from "@agent-infra/platform-core";
import { parseWecomXml } from "./xml.js";

export interface WecomConfigurationV1 {
	readonly bindingReference: string;
	readonly agentId: string;
	readonly kind: "wecom_bot" | "wecom_app";
	readonly token: string;
	readonly encodingAesKey: string;
	readonly credentialVersion: string;
	readonly botId?: string;
	readonly corporationId?: string;
	readonly applicationId?: string;
}
export class WecomProtocolError extends Error {
	constructor() {
		super("Invalid WeCom callback");
	}
}
function invalid(): never {
	throw new WecomProtocolError();
}
function field(value: unknown, max = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!value.isWellFormed() ||
		value.includes("\0") ||
		Buffer.byteLength(value) > max
	)
		return invalid();
	return value;
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	return value as Record<string, unknown>;
}
function exactRecord(value: unknown, keys: readonly string[]) {
	const result = record(value);
	if (
		Object.keys(result).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(result, key))
	)
		return invalid();
	return result;
}
export function createWecomAdapterV1(options: {
	readonly now?: () => Date;
	readonly protectReply: (route: {
		readonly bindingReference: string;
		readonly credentialVersion: string;
		readonly scope: WecomScopeV1;
		readonly responseUrl?: string;
		readonly recipientId?: string;
		readonly expiresAt: string;
	}) => Promise<string>;
}) {
	const now = options.now ?? (() => new Date());
	return {
		passiveReply(
			config: WecomConfigurationV1,
			request: Request,
			message: WecomMessageV1,
			text: string,
		): Response {
			const nonce = field(new URL(request.url).searchParams.get("nonce"), 256);
			const timestamp = Math.floor(now().getTime() / 1000);
			const xmlEscape = (value: string) =>
				value
					.replaceAll("&", "&amp;")
					.replaceAll("<", "&lt;")
					.replaceAll(">", "&gt;");
			const content =
				config.kind === "wecom_bot"
					? JSON.stringify({
							msgtype: "stream",
							stream: {
								id: createHash("sha256").update(message.eventId).digest("hex"),
								finish: true,
								content: text,
							},
						})
					: `<xml><ToUserName>${xmlEscape(message.senderId)}</ToUserName><FromUserName>${xmlEscape(config.corporationId ?? "")}</FromUserName><CreateTime>${timestamp}</CreateTime><MsgType>text</MsgType><Content>${xmlEscape(text)}</Content></xml>`;
			const bytes = Buffer.from(content);
			const length = Buffer.alloc(4);
			length.writeUInt32BE(bytes.length);
			const plain = Buffer.concat([
				randomBytes(16),
				length,
				bytes,
				Buffer.from(
					config.kind === "wecom_bot" ? "" : (config.corporationId ?? ""),
				),
			]);
			const key = Buffer.from(`${config.encodingAesKey}=`, "base64");
			const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
			cipher.setAutoPadding(false);
			const pad = 32 - (plain.length % 32);
			const encrypt = Buffer.concat([
				cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
				cipher.final(),
			]).toString("base64");
			const signature = createHash("sha1")
				.update(
					[config.token, String(timestamp), nonce, encrypt].sort().join(""),
				)
				.digest("hex");
			return config.kind === "wecom_bot"
				? Response.json({ encrypt, msgsignature: signature, timestamp, nonce })
				: new Response(
						`<xml><Encrypt>${encrypt}</Encrypt><MsgSignature>${signature}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${xmlEscape(nonce)}</Nonce></xml>`,
						{ headers: { "Content-Type": "application/xml" } },
					);
		},
		async receive(
			config: WecomConfigurationV1,
			request: Request,
		): Promise<
			| { type: "challenge"; text: string }
			| { type: "message"; message: WecomMessageV1 }
		> {
			try {
				field(config.bindingReference);
				field(config.agentId);
				field(config.credentialVersion);
				field(config.token, 256);
				if (config.kind === "wecom_bot") field(config.botId);
				else if (config.kind === "wecom_app") {
					field(config.corporationId);
					if (!/^\d+$/.test(field(config.applicationId))) return invalid();
				} else return invalid();
				const url = new URL(request.url);
				const timestamp = field(url.searchParams.get("timestamp"), 20);
				const nonce = field(url.searchParams.get("nonce"), 256);
				const signature = field(url.searchParams.get("msg_signature"), 40);
				if (
					!/^\d+$/.test(timestamp) ||
					Math.abs(now().getTime() / 1000 - Number(timestamp)) > 300 ||
					!/^[a-f0-9]{40}$/.test(signature)
				)
					return invalid();
				if (
					!["GET", "POST"].includes(request.method) ||
					["timestamp", "nonce", "msg_signature", "echostr"].some(
						(k) => url.searchParams.getAll(k).length > 1,
					)
				)
					return invalid();
				const raw = request.method === "GET" ? "" : await boundedBody(request);
				if (Buffer.byteLength(raw) > 128 * 1024) return invalid();
				const encrypted =
					request.method === "GET"
						? field(url.searchParams.get("echostr"), 128 * 1024)
						: field(
								config.kind === "wecom_bot"
									? exactRecord(JSON.parse(raw), ["encrypt"]).encrypt
									: exactRecord(parseWecomXml(raw), ["Encrypt"]).Encrypt,
								128 * 1024,
							);
				const expected = createHash("sha1")
					.update([config.token, timestamp, nonce, encrypted].sort().join(""))
					.digest();
				if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
					return invalid();
				const key = Buffer.from(`${config.encodingAesKey}=`, "base64");
				if (
					key.length !== 32 ||
					!/^[A-Za-z0-9+/]{43}$/.test(config.encodingAesKey)
				)
					return invalid();
				const cipherBytes = Buffer.from(encrypted, "base64");
				if (
					cipherBytes.toString("base64") !== encrypted ||
					cipherBytes.length % 16 !== 0
				)
					return invalid();
				const decipher = createDecipheriv(
					"aes-256-cbc",
					key,
					key.subarray(0, 16),
				);
				decipher.setAutoPadding(false);
				const padded = Buffer.concat([
					decipher.update(cipherBytes),
					decipher.final(),
				]);
				const pad = padded.at(-1) ?? 0;
				if (
					pad < 1 ||
					pad > 32 ||
					!padded.subarray(-pad).every((value) => value === pad)
				)
					return invalid();
				const plain = padded.subarray(0, -pad);
				if (plain.length < 20) return invalid();
				const length = plain.readUInt32BE(16);
				if (length > plain.length - 20) return invalid();
				const receiver = plain.subarray(20 + length).toString("utf8");
				if (
					receiver !== (config.kind === "wecom_bot" ? "" : config.corporationId)
				)
					return invalid();
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					plain.subarray(20, 20 + length),
				);
				if (request.method === "GET") return { type: "challenge", text };
				if (config.kind === "wecom_app") {
					const payload = parseWecomXml(text);
					if (
						payload.MsgType !== "text" ||
						payload.ToUserName !== config.corporationId ||
						payload.AgentID !== config.applicationId ||
						!/^\d+$/.test(payload.CreateTime ?? "") ||
						Math.abs(now().getTime() / 1000 - Number(payload.CreateTime)) > 300
					)
						return invalid();
					const senderId = field(payload.FromUserName);
					const content = field(payload.Content, 32 * 1024);
					const eventId = field(payload.MsgId);
					const expiresAt = new Date(
						Number(timestamp) * 1000 + 3600_000,
					).toISOString();
					const replyHandle = await options.protectReply({
						bindingReference: config.bindingReference,
						credentialVersion: config.credentialVersion,
						recipientId: senderId,
						expiresAt,
						scope: {
							agentId: config.agentId,
							bindingReference: config.bindingReference,
							kind: config.kind,
							senderId,
							peerId: senderId,
							conversationType: "single",
							threadId: null,
						},
					});
					return {
						type: "message",
						message: {
							agentId: config.agentId,
							bindingReference: config.bindingReference,
							kind: config.kind,
							eventId,
							providerId: JSON.stringify([
								config.corporationId,
								config.applicationId,
							]),
							senderId,
							peerId: senderId,
							conversationType: "single",
							threadId: null,
							text: content,
							replyHandle,
							replyExpiresAt: expiresAt,
						},
					};
				}
				const payload = record(JSON.parse(text));
				if (
					config.kind !== "wecom_bot" ||
					payload.aibotid !== config.botId ||
					payload.msgtype !== "text"
				)
					return invalid();
				if (payload.chattype !== "single" && payload.chattype !== "group")
					return invalid();
				const senderId = field(record(payload.from).userid);
				const responseUrl = new URL(field(payload.response_url, 4096));
				if (
					responseUrl.origin !== "https://qyapi.weixin.qq.com" ||
					responseUrl.pathname !== "/cgi-bin/aibot/response" ||
					responseUrl.username ||
					responseUrl.password ||
					responseUrl.hash ||
					!responseUrl.searchParams.get("response_code")
				)
					return invalid();
				const peerId =
					payload.chattype === "group" ? field(payload.chatid) : senderId;
				const content = field(record(payload.text).content, 32 * 1024);
				const eventId = field(payload.msgid);
				const expiresAt = new Date(
					Number(timestamp) * 1000 + 3600_000,
				).toISOString();
				const replyHandle = await options.protectReply({
					bindingReference: config.bindingReference,
					credentialVersion: config.credentialVersion,
					responseUrl: responseUrl.href,
					expiresAt,
					scope: {
						agentId: config.agentId,
						bindingReference: config.bindingReference,
						kind: config.kind,
						senderId,
						peerId,
						conversationType: payload.chattype,
						threadId: null,
					},
				});
				return {
					type: "message",
					message: {
						agentId: config.agentId,
						bindingReference: config.bindingReference,
						kind: config.kind,
						eventId,
						providerId: field(config.botId),
						senderId,
						peerId,
						conversationType: payload.chattype,
						threadId: null,
						text: content,
						replyHandle,
						replyExpiresAt: expiresAt,
					},
				};
			} catch {
				return invalid();
			}
		},
	};
}

async function boundedBody(request: Request): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return invalid();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 128 * 1024) {
				await reader.cancel();
				return invalid();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.concat(chunks),
	);
}

export { createWecomChannelAdmissionV1 } from "./admission.js";
export {
	createWecomReplyEncryptorV1,
	type WecomReplyRouteV1,
} from "./reply.js";
