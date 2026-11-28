import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import {
	ipv4ReservedRanges,
	ipv6ReservedRanges,
} from "@agent-infra/contracts/workload";

const reservedV4 = new BlockList();
const reservedV6 = new BlockList();
for (const [address, prefix] of ipv4ReservedRanges)
	reservedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of ipv6ReservedRanges)
	reservedV6.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function isPublicAddress(ip: string) {
	const family = isIP(ip);
	return family === 4
		? !reservedV4.check(ip, "ipv4")
		: family === 6 &&
				globalV6.check(ip, "ipv6") &&
				!reservedV6.check(ip, "ipv6");
}

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
	return isIP(host) !== 0 && !isPublicAddress(host);
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
	const url = assertAllowedUrl(origin, new Set([origin]));
	if (
		!isIP(url.hostname.replace(/^\[|\]$/gu, "")) &&
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/iu.test(
			url.hostname,
		)
	)
		throw new Error("BROWSER_POLICY_ORIGIN_INVALID");
	return url;
}

/** Chromium connects only to the public addresses resolved for this context. */
export async function readOnlyBrowserNetwork(origins: readonly string[]) {
	if (!origins.length) throw new Error("BROWSER_POLICY_ORIGIN_INVALID");
	const urls = origins.map(publicBrowserOrigin);
	const hosts = [...new Set(urls.map((url) => url.hostname))];
	const rules = await Promise.all(
		hosts.map(async (host) => {
			const literal = host.replace(/^\[|\]$/gu, "");
			if (isIP(literal)) return "EXCLUDE " + host;
			const addresses = await dns.lookup(host, { all: true });
			const address = addresses.find((entry) =>
				isPublicAddress(entry.address),
			)?.address;
			if (!address) throw new Error("BROWSER_NAVIGATION_PRIVATE_TARGET_DENIED");
			return (
				"MAP " +
				host +
				" " +
				(isIP(address) === 6 ? "[" + address + "]" : address)
			);
		}),
	);
	const bypass = urls.map(
		(url) =>
			url.protocol +
			"//" +
			url.hostname +
			":" +
			(url.port || (url.protocol === "https:" ? "443" : "80")),
	);
	return {
		proxy: {
			server: "http://127.0.0.1:9",
			bypass: ["<-loopback>", ...bypass].join(","),
		},
		serviceWorkers: "block" as const,
		args: [
			"--host-resolver-rules=" + [...rules, "MAP * ~NOTFOUND"].join(", "),
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		],
	};
}
