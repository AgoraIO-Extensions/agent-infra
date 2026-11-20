import { ServerResponse } from "node:http";
import type { ApplicationCredentialMaterialMetadataV1 } from "@agent-infra/platform-core";

/** Only the trusted Node binding can carry material. No memory-only consumer fallback. */
export function applicationCredentialMaterialResponseV1(
	bindings: unknown,
	request: Request,
) {
	const outgoing =
		bindings && typeof bindings === "object" && "outgoing" in bindings
			? bindings.outgoing
			: undefined;
	if (!(outgoing instanceof ServerResponse))
		throw new Error("Material transport unavailable");
	return {
		get sent() {
			return outgoing.headersSent;
		},
		abort() {
			if (!outgoing.writableFinished) outgoing.destroy();
		},
		async write(
			material: string,
			delivery: ApplicationCredentialMaterialMetadataV1,
			signal: AbortSignal,
		) {
			await new Promise<void>((resolve, reject) => {
				const unavailable = () => new Error("Material transport unavailable");
				const cleanup = () => {
					outgoing.off("finish", finish);
					outgoing.off("close", close);
					outgoing.off("error", close);
					signal.removeEventListener("abort", abort);
				};
				const finish = () => {
					cleanup();
					resolve();
				};
				const close = () => {
					cleanup();
					reject(unavailable());
				};
				const abort = () => {
					outgoing.destroy();
					close();
				};
				outgoing.once("finish", finish);
				outgoing.once("close", close);
				outgoing.once("error", close);
				signal.addEventListener("abort", abort, { once: true });
				try {
					// The check and the actual socket write have no asynchronous gap.
					if (
						signal.aborted ||
						request.signal.aborted ||
						outgoing.destroyed ||
						Date.now() >= Date.parse(delivery.expiresAt)
					)
						throw unavailable();
					const body = JSON.stringify({
						schemaVersion: 1,
						kind: "material",
						delivery,
						material,
					});
					outgoing.writeHead(200, {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
						"Cache-Control": "no-store",
						"Referrer-Policy": "no-referrer",
						"X-Accel-Buffering": "no",
					});
					outgoing.end(body);
				} catch {
					abort();
				}
			});
		},
	};
}
