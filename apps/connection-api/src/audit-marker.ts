import { createHmac } from "node:crypto";

export function redactedLoginMarker(
	key: Buffer,
	environment: string,
	kind: "account" | "source",
	value: string,
): string {
	return createHmac("sha256", key)
		.update(`auth-audit\u0000${environment}\u0000${kind}\u0000${value}`)
		.digest("hex");
}
