import { timingSafeEqual } from "node:crypto";

/** Only the deployment's TLS proxy and API share this credential. */
export function createTrustedProxyVerifier(token: string) {
	if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(token))
		throw new Error("BROWSER_SESSION_PROXY_CONFIGURATION_INVALID");
	const expected = Buffer.from(token);
	return (request: Request) => {
		const supplied = Buffer.from(
			request.headers.get("x-platform-proxy-token") ?? "",
		);
		return (
			supplied.length === expected.length && timingSafeEqual(supplied, expected)
		);
	};
}
