import type { WecomMediaDownloadV1 } from "@agent-infra/platform-core";
import { decryptFile } from "@wecom/aibot-node-sdk";

export type WecomMediaDownloadResultV1 =
	| {
			readonly outcome: "downloaded";
			readonly bytes: Buffer;
			/** 下载响应 Content-Disposition 中的文件名，与 SDK `downloadFile` 的解析规则一致。 */
			readonly filename: string | null;
	  }
	| { readonly outcome: "too_large" | "expired" | "failed" };

/** 与 SDK `downloadFileRaw` 相同：优先 RFC 5987 的 `filename*=UTF-8''`，其次 `filename=`。 */
function dispositionFilename(header: string | null): string | null {
	if (!header) return null;
	const match =
		header.match(/filename\*=UTF-8''([^;\s]+)/i) ??
		header.match(/filename="?([^";\s]+)"?/i);
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

/**
 * 企微智能机器人长连接的入站媒体下载（工程 Spec §14.2.3，#3227）。
 *
 * 固定版本 SDK 的 `downloadFile` 把整个响应读进内存，没有大小上限，因此这里自行做有界下载：
 * 时间不超过 `timeoutMs` 与下载地址剩余有效期，密文不超过 `maxBytes` 加一个 32 字节填充块。
 * 解密仍调用同一 SDK 导出的 `decryptFile`（AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 按 32 字节
 * 填充），与 SDK 的加密格式一致。所有失败都折叠为固定结果，不带下载地址、aeskey 或响应内容。
 */
export async function downloadWecomMediaV1(input: {
	readonly download: WecomMediaDownloadV1;
	readonly maxBytes: number;
	readonly timeoutMs: number;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
}): Promise<WecomMediaDownloadResultV1> {
	const now = input.now ?? Date.now;
	const expiresAt = Date.parse(input.download.expiresAt);
	if (
		!Number.isSafeInteger(input.maxBytes) ||
		input.maxBytes < 1 ||
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs < 1
	)
		return { outcome: "failed" };
	if (!Number.isFinite(expiresAt) || expiresAt <= now())
		return { outcome: "expired" };
	const key = Buffer.from(input.download.aesKey, "base64");
	if (key.length !== 32) return { outcome: "failed" };
	const deadline = AbortSignal.timeout(
		Math.max(1, Math.min(input.timeoutMs, expiresAt - now())),
	);
	const signal = input.signal
		? AbortSignal.any([input.signal, deadline])
		: deadline;
	const failure = () =>
		({ outcome: now() >= expiresAt ? "expired" : "failed" }) as const;
	const maxEncryptedBytes = input.maxBytes + 32;
	const request = input.fetch ?? fetch;
	let response: Response | undefined;
	try {
		let url = new URL(input.download.url);
		// 只跟随有限次 HTTPS 重定向，不降级到明文，也不带凭据。
		for (let hop = 0; ; hop++) {
			if (url.protocol !== "https:" || url.username || url.password)
				return { outcome: "failed" };
			response = await request(url, {
				method: "GET",
				redirect: "manual",
				signal,
			});
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => undefined);
			response = undefined;
			if (!location || hop >= 3) return failure();
			url = new URL(location, url);
		}
		if (!response.ok || !response.body) {
			await response.body?.cancel().catch(() => undefined);
			return failure();
		}
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) > maxEncryptedBytes) {
			await response.body.cancel().catch(() => undefined);
			return { outcome: "too_large" };
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > maxEncryptedBytes) {
					await reader.cancel().catch(() => undefined);
					return { outcome: "too_large" };
				}
				chunks.push(next.value);
			}
		} finally {
			reader.releaseLock();
		}
		if (size === 0) return failure();
		let bytes: Buffer;
		try {
			bytes = decryptFile(Buffer.concat(chunks), input.download.aesKey);
		} catch {
			// 解密错误信息可能含填充细节，不向外传递。
			return failure();
		}
		if (bytes.length > input.maxBytes) return { outcome: "too_large" };
		if (bytes.length === 0) return { outcome: "failed" };
		return {
			outcome: "downloaded",
			bytes,
			filename: dispositionFilename(
				response.headers.get("content-disposition"),
			),
		};
	} catch {
		await response?.body?.cancel().catch(() => undefined);
		return failure();
	}
}
