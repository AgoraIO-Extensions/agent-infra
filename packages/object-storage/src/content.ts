import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";

export type ObjectContentPolicyV1 = "file" | "skill-package";

export function createContentProbe(
	maxBytes: number,
	expectedMediaType?: string,
	policy: ObjectContentPolicyV1 = "file",
) {
	const hash = createHash("sha256");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = true;
	let sizeBytes = 0;
	let prefix = new Uint8Array();
	const evidenceJson: Uint8Array[] = [];
	return {
		write(chunk: Uint8Array) {
			sizeBytes += chunk.byteLength;
			if (sizeBytes > maxBytes) throw new Error("File content limit exceeded");
			hash.update(chunk);
			if (
				policy === "skill-package" &&
				expectedMediaType === "application/json"
			) {
				if (sizeBytes > 2_000_000)
					throw new Error("Package evidence limit exceeded");
				evidenceJson.push(chunk.slice());
			}
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
			if (
				policy === "skill-package" &&
				expectedMediaType !== "application/zip" &&
				expectedMediaType !== "application/json" &&
				expectedMediaType !== "application/octet-stream"
			)
				throw new Error("Unsupported skill package media type");
			if (text) {
				try {
					decoder.decode();
				} catch {
					text = false;
				}
			}
			let evidenceType: string | undefined;
			if (
				policy === "skill-package" &&
				expectedMediaType === "application/json"
			) {
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
						Buffer.concat(evidenceJson),
					),
				);
				evidenceType = "application/json";
			}
			// Detached Ed25519 bytes have no file magic. This purpose is selected only
			// by the server's separate package storage, after the supplier verifies the signature.
			if (
				policy === "skill-package" &&
				expectedMediaType === "application/octet-stream"
			) {
				if (sizeBytes !== 64)
					throw new Error("Invalid detached signature size");
				evidenceType = "application/octet-stream";
			}
			const detected =
				!evidenceType && prefix.length
					? await fileTypeFromBuffer(prefix)
					: undefined;
			const mediaType =
				evidenceType ?? detected?.mime ?? (text ? "text/plain" : null);
			if (
				policy === "skill-package" &&
				expectedMediaType === "application/zip" &&
				mediaType !== "application/zip"
			)
				throw new Error("Invalid skill package archive type");
			if (!mediaType) throw new Error("File format cannot be verified");
			return { sizeBytes, mediaType, sha256: hash.digest("hex") };
		},
	};
}
