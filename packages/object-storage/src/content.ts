import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";

export function createContentProbe(maxBytes: number) {
	const hash = createHash("sha256");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = true;
	let sizeBytes = 0;
	let prefix = new Uint8Array();
	return {
		write(chunk: Uint8Array) {
			sizeBytes += chunk.byteLength;
			if (sizeBytes > maxBytes) throw new Error("File content limit exceeded");
			hash.update(chunk);
			if (prefix.byteLength < 8192)
				prefix = Buffer.concat([
					prefix,
					chunk.subarray(0, 8192 - prefix.byteLength),
				]);
			if (text) {
				try {
					decoder.decode(chunk, { stream: true });
					if (
						chunk.some(
							(value) =>
								(value < 32 && ![9, 10, 13].includes(value)) || value === 127,
						)
					)
						text = false;
				} catch {
					text = false;
				}
			}
		},
		async finish() {
			if (text) {
				try {
					decoder.decode();
				} catch {
					text = false;
				}
			}
			const detected = prefix.length
				? await fileTypeFromBuffer(prefix)
				: undefined;
			const mediaType = detected?.mime ?? (text ? "text/plain" : null);
			if (!mediaType) throw new Error("File format cannot be verified");
			return { sizeBytes, mediaType, sha256: hash.digest("hex") };
		},
	};
}
