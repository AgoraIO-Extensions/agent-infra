import { timingSafeEqual } from "node:crypto";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import { Hono } from "hono";
import { z } from "zod";

const path = "/internal/platform/v1/native-metadata/current";
const maximumBodyBytes = 64 * 1024;
const defaultCheckerTimeoutMs = 10_000;
const requestSchema = z.strictObject({
	apiRequestSourceRef: z.string().min(1).max(256),
	request: NativeMetadataCurrentRequestV1Schema,
});

export interface NativeMetadataCurrentRouteDependenciesV1 {
	readonly serviceToken: string;
	check(input: {
		readonly request: NativeMetadataCurrentRequestV1;
		readonly apiRequestSourceRef: string;
		readonly signal: AbortSignal;
	}): Promise<NativeMetadataCurrentResponseV1>;
}

function authorized(header: string | undefined, token: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const received = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(token);
	return (
		received.length === expected.length && timingSafeEqual(received, expected)
	);
}

async function boundedBody(request: Request): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximumBodyBytes) {
				await reader.cancel();
				throw new Error("NATIVE_METADATA_CURRENT_BODY_TOO_LARGE");
			}
			chunks.push(next.value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks, bytes),
		);
	} finally {
		reader.releaseLock();
	}
}

/** Internal Worker current-confirmation route; caller identity is never accepted from headers/body. */
export function createNativeMetadataCurrentAppV1(
	dependencies: NativeMetadataCurrentRouteDependenciesV1,
	options: { readonly checkerTimeoutMs?: number } = {},
) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(dependencies.serviceToken))
		throw new TypeError("Native metadata current service token is invalid");
	if (typeof dependencies.check !== "function")
		throw new TypeError("Native metadata current checker is invalid");
	const checkerTimeoutMs = options.checkerTimeoutMs ?? defaultCheckerTimeoutMs;
	if (
		!Number.isSafeInteger(checkerTimeoutMs) ||
		checkerTimeoutMs < 1 ||
		checkerTimeoutMs > 30_000
	)
		throw new TypeError("Native metadata current checker timeout is invalid");
	const app = new Hono();
	app.post(path, async (context) => {
		if (
			!authorized(
				context.req.header("authorization"),
				dependencies.serviceToken,
			)
		)
			return context.json({ outcome: "unavailable" }, 401);
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (!controller.signal.aborted)
				controller.abort(context.req.raw.signal.reason);
		};
		if (context.req.raw.signal.aborted) abort();
		else
			context.req.raw.signal.addEventListener("abort", abort, { once: true });
		try {
			const body = await boundedBody(context.req.raw);
			const parsed = requestSchema.parse(JSON.parse(body));
			const checker = dependencies.check({
				request: parsed.request,
				apiRequestSourceRef: parsed.apiRequestSourceRef,
				signal: controller.signal,
			});
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					abort();
					reject(new Error("NATIVE_METADATA_CURRENT_CHECK_TIMEOUT"));
				}, checkerTimeoutMs);
			});
			const response = NativeMetadataCurrentResponseV1Schema.parse(
				await Promise.race([checker, deadline]),
			);
			return context.json(response, response.outcome === "denied" ? 403 : 200);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "NATIVE_METADATA_CURRENT_BODY_TOO_LARGE"
			)
				return context.json({ outcome: "unavailable" }, 400);
			return context.json({ outcome: "unavailable" }, 503);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			context.req.raw.signal.removeEventListener("abort", abort);
			controller.abort();
		}
	});
	return app;
}
