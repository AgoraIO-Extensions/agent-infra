import { lookup as dnsLookup } from "node:dns/promises";
import {
	type GuardedFetchDnsLookup,
	resolveGuardedEgressTarget,
} from "@agent-infra/openconnector-kernel";
import { Agent, fetch as undiciFetch } from "undici";

/** Connect-time validation: the connector consumes these IPs, never another resolver. */
export function createPinnedProviderFetch(options: {
	origins: readonly string[];
	privateOrigins?: readonly string[];
	lookup?: GuardedFetchDnsLookup;
	ca?: string;
}) {
	const origins = new Set(
		options.origins.map((value) => new URL(value).origin),
	);
	const privateOrigins = new Set(
		(options.privateOrigins ?? []).map((value) => new URL(value).origin),
	);
	if (
		origins.size === 0 ||
		[...privateOrigins].some((value) => !origins.has(value))
	)
		throw new Error("Provider origins must be explicitly allowed");
	const hosts = new Map(
		[...origins].map((origin) => [new URL(origin).hostname, origin]),
	);
	for (const origin of origins) {
		const sameHost = hosts.get(new URL(origin).hostname);
		if (sameHost && privateOrigins.has(sameHost) !== privateOrigins.has(origin))
			throw new Error(
				"A Provider hostname cannot mix private-network policies",
			);
	}
	const lookup = options.lookup ?? ((host) => dnsLookup(host, { all: true }));
	const dispatcher = new Agent({
		connect: {
			...(options.ca ? { ca: options.ca } : {}),
			timeout: 10_000,
			lookup: (hostname, lookupOptions, callback) => {
				const origin = hosts.get(hostname);
				if (!origin) {
					callback(new Error("Provider hostname is not allowed"), "", 4);
					return;
				}
				void resolveGuardedEgressTarget(origin, {
					allowPrivateNetwork: privateOrigins.has(origin),
					createError: () =>
						new Error("Provider resolved address is not allowed"),
					fieldName: "Provider URL",
					lookup,
				}).then(
					({ addresses }) => {
						const family =
							typeof lookupOptions === "number"
								? lookupOptions
								: lookupOptions.family;
						const selected = addresses.filter(
							(entry) =>
								(family !== 4 && family !== 6) || entry.family === family,
						);
						const first = selected[0];
						if (!first) {
							callback(new Error("Provider DNS has no allowed address"), "", 4);
							return;
						}
						if (typeof lookupOptions === "object" && lookupOptions.all) {
							(callback as (error: null, addresses: typeof selected) => void)(
								null,
								selected,
							);
						} else {
							callback(null, first.address, first.family);
						}
					},
					() => callback(new Error("Provider DNS validation failed"), "", 4),
				);
			},
		},
	});
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!origins.has(url.origin) || url.username || url.password || url.hash)
			throw new Error("Provider origin is not allowed");
		const headers = request.headers;
		if (
			[...headers.keys()].some(
				(key) => key === "host" || key.startsWith("proxy-"),
			)
		)
			throw new Error("Provider routing headers are not allowed");
		// Literal IPs do not call connect.lookup; validate them before credentials leave.
		await resolveGuardedEgressTarget(url.toString(), {
			allowPrivateNetwork: privateOrigins.has(url.origin),
			createError: () => new Error("Provider target address is not allowed"),
			fieldName: "Provider URL",
			lookup: null,
		});
		return undiciFetch(request.url, {
			method: request.method,
			headers,
			body: request.body,
			duplex: "half",
			signal: request.signal,
			dispatcher,
			redirect: "manual",
		} as never) as unknown as Promise<Response>;
	};
	return { fetch: fetcher, close: () => dispatcher.close() };
}
