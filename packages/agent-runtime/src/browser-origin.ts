import { isIP } from "node:net";

export function normalizeOrigin(value: string): string {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("BROWSER_POLICY_ORIGIN_INVALID");
	return url.origin;
}

function isPrivateHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	if (
		host === "localhost" ||
		host === "metadata.google.internal" ||
		host === "metadata.google" ||
		host === "instance-data.ec2.internal"
	)
		return true;
	const kind = isIP(host);
	if (kind === 4) {
		const [a, b] = host.split(".").map(Number);
		return (
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		);
	}
	if (kind === 6) {
		return (
			host === "::1" ||
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("fe8")
		);
	}
	return false;
}

export function assertAllowedUrl(
	value: string,
	allowedOrigins: ReadonlySet<string>,
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("BROWSER_NAVIGATION_URL_INVALID");
	}
	if (!new Set(["http:", "https:"]).has(url.protocol))
		throw new Error("BROWSER_NAVIGATION_SCHEME_DENIED");
	if (url.username || url.password || isPrivateHostname(url.hostname))
		throw new Error("BROWSER_NAVIGATION_PRIVATE_TARGET_DENIED");
	if (!allowedOrigins.has(url.origin))
		throw new Error("BROWSER_NAVIGATION_ORIGIN_DENIED");
	return url;
}

/** Prepare an exact network-service rule from a validated public Manifest origin. */
export function publicBrowserOrigin(value: string): URL {
	const origin = normalizeOrigin(value);
	return assertAllowedUrl(origin, new Set([origin]));
}
