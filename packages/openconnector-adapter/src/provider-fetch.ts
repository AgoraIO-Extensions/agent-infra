import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import {
	type GuardedFetchDnsLookup,
	resolveGuardedEgressTarget,
} from "@agent-infra/openconnector-kernel";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/** Connect-time validation: the connector consumes these IPs, never another resolver. */
export function createPinnedProviderFetch(options: {
	origins: readonly string[];
	privateOrigins?: readonly string[];
	lookup?: GuardedFetchDnsLookup;
	ca?: string;
	proxyUrl?: string;
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
	const directConnect = buildConnector({
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
	});
	const dispatcher = new Agent({
		// Do not pool fallback sockets: the next request must try the proxy again.
		...(options.proxyUrl ? { pipelining: 0 } : {}),
		connect: options.proxyUrl
			? proxyFirstConnector(options.proxyUrl, directConnect, {
					lookup,
					origins,
					privateOrigins,
					ca: options.ca,
				})
			: directConnect,
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

/** Fallback happens inside connect, before Undici receives a socket or sends a body. */
function proxyFirstConnector(
	proxyUrl: string,
	directConnect: buildConnector.connector,
	options: {
		lookup: GuardedFetchDnsLookup;
		origins: Set<string>;
		privateOrigins: Set<string>;
		ca?: string;
	},
): buildConnector.connector {
	const proxy = new URL(proxyUrl);
	if (
		!["http:", "https:"].includes(proxy.protocol) ||
		proxy.username ||
		proxy.password ||
		proxy.pathname !== "/" ||
		proxy.search ||
		proxy.hash
	)
		throw new Error("Provider proxy must be a credential-free HTTP origin");
	const proxyHostname = proxy.hostname.replace(/^\[|\]$/g, "");
	const tunnelConnect = buildConnector({ timeout: 10_000, ca: options.ca });
	return (connection, callback) => {
		void (async () => {
			if (connection.protocol !== "https:")
				throw new Error("Provider proxy only supports HTTPS targets");
			const hostname =
				connection.hostname.includes(":") &&
				!connection.hostname.startsWith("[")
					? `[${connection.hostname}]`
					: connection.hostname;
			const origin = new URL(
				`${connection.protocol}//${hostname}:${connection.port}`,
			).origin;
			if (!options.origins.has(origin))
				throw new Error("Provider origin is not allowed");
			// Validate both DNS answer sets before sending even CONNECT to the proxy.
			const resolve = (url: string) =>
				resolveGuardedEgressTarget(url, {
					allowPrivateNetwork: options.privateOrigins.has(new URL(url).origin),
					createError: () =>
						new Error("Provider proxy target address is not allowed"),
					fieldName: "Provider URL",
					lookup: options.lookup,
				});
			const target = (await resolve(origin)).addresses[0];
			const proxyTarget = (await resolve(proxy.origin)).addresses[0];
			if (!target || !proxyTarget)
				throw new Error("Provider proxy DNS has no allowed address");
			const authority = `${target.family === 6 ? `[${target.address}]` : target.address}:${connection.port}`;
			let tunnel: Socket;
			try {
				tunnel = await new Promise<Socket>((resolveTunnel, reject) => {
					const request = (
						proxy.protocol === "https:" ? httpsRequest : httpRequest
					)({
						hostname: proxyHostname,
						// CONNECT Host names the target IP; it must not select the proxy TLS identity.
						servername: isIP(proxyHostname) ? "" : proxyHostname,
						ca: options.ca,
						port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
						method: "CONNECT",
						path: authority,
						headers: { host: authority },
						agent: false,
						lookup: (_hostname, lookupOptions, done) => {
							if (typeof lookupOptions === "object" && lookupOptions.all) {
								(
									done as (
										error: null,
										addresses: (typeof proxyTarget)[],
									) => void
								)(null, [proxyTarget]);
							} else done(null, proxyTarget.address, proxyTarget.family);
						},
					});
					// Wall-clock deadline also covers DNS/socket stalls before HTTP timeout starts.
					const deadline = setTimeout(
						() =>
							request.destroy(
								Object.assign(new Error("Provider proxy CONNECT timed out"), {
									code: "ETIMEDOUT",
								}),
							),
						10_000,
					);
					request.once("error", (error) => {
						clearTimeout(deadline);
						reject(error);
					});
					request.once("connect", (response, socket, head) => {
						clearTimeout(deadline);
						if (response.statusCode !== 200 || head.length) {
							socket.destroy();
							reject(
								Object.assign(new Error("Provider proxy CONNECT rejected"), {
									code: [502, 503, 504].includes(response.statusCode ?? 0)
										? "PROXY_UNAVAILABLE"
										: "PROXY_REJECTED",
								}),
							);
							return;
						}
						resolveTunnel(socket);
					});
					request.end();
				});
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (
					![
						"ECONNREFUSED",
						"ECONNRESET",
						"ETIMEDOUT",
						"EHOSTUNREACH",
						"ENETUNREACH",
						"PROXY_UNAVAILABLE",
					].includes(code ?? "")
				)
					throw error;
				// No Provider TLS socket has been handed to Undici; even POST is unsubmitted.
				directConnect(connection, callback);
				return;
			}
			// TLS errors after CONNECT never fallback. Original hostname remains SNI/Host.
			tunnelConnect({ ...connection, httpSocket: tunnel }, callback);
		})().catch((error) => callback(error, null));
	};
}
