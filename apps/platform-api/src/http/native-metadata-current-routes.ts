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

/** Internal Worker current-confirmation route; caller identity is never accepted from headers/body. */
export function createNativeMetadataCurrentAppV1(
	dependencies: NativeMetadataCurrentRouteDependenciesV1,
) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(dependencies.serviceToken))
		throw new TypeError("Native metadata current service token is invalid");
	if (typeof dependencies.check !== "function")
		throw new TypeError("Native metadata current checker is invalid");
	const app = new Hono();
	app.post(path, async (context) => {
		if (
			!authorized(
				context.req.header("authorization"),
				dependencies.serviceToken,
			)
		)
			return context.json({ outcome: "unavailable" }, 401);
		try {
			const body = await context.req.raw.text();
			if (Buffer.byteLength(body, "utf8") > maximumBodyBytes)
				return context.json({ outcome: "unavailable" }, 400);
			const parsed = requestSchema.parse(JSON.parse(body));
			const response = NativeMetadataCurrentResponseV1Schema.parse(
				await dependencies.check({
					request: parsed.request,
					apiRequestSourceRef: parsed.apiRequestSourceRef,
					signal: context.req.raw.signal,
				}),
			);
			return context.json(response, response.outcome === "denied" ? 403 : 200);
		} catch {
			return context.json({ outcome: "unavailable" }, 503);
		}
	});
	return app;
}
