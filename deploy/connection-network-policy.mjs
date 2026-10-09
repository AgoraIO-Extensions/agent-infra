import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

/** Render exact operator-reviewed dependencies, never a guessed public CIDR. */
export function connectionNetworkPolicy(input) {
	if (!input || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(input.namespace ?? ""))
		throw new Error("A valid namespace is required");
	if (!Array.isArray(input.dependencies) || input.dependencies.length === 0)
		throw new Error("Reviewed dependency addresses are required");
	const kinds = new Set();
	const egress = input.dependencies.map((dependency) => {
		const family = isIP(dependency.address ?? "");
		if (!family || !Number.isInteger(dependency.port) || dependency.port < 1 || dependency.port > 65535 ||
			!["TCP", "UDP"].includes(dependency.protocol) || !["dns", "ldap", "postgres", "provider", "proxy", "directory"].includes(dependency.kind))
			throw new Error("Dependency must contain an exact IP, port, protocol and kind");
		if (dependency.kind !== "dns" && dependency.protocol !== "TCP")
			throw new Error("Non-DNS dependencies require TCP");
		if (dependency.kind === "dns" && dependency.port !== 53)
			throw new Error("DNS dependencies require port 53");
		kinds.add(dependency.kind);
		return {
			to: [{ ipBlock: { cidr: `${dependency.address}/${family === 4 ? 32 : 128}` } }],
			ports: [{ protocol: dependency.protocol, port: dependency.port }],
		};
	});
	if (!["dns", "ldap", "postgres"].every((kind) => kinds.has(kind)) ||
		(!kinds.has("provider") && !kinds.has("proxy")) ||
		!["TCP", "UDP"].every((protocol) => input.dependencies.some((entry) => entry.kind === "dns" && entry.protocol === protocol)))
		throw new Error("Both DNS protocols, LDAP, PostgreSQL and approved Provider egress are required");
	return {
		apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
		metadata: { name: "connection-api-reviewed-egress", namespace: input.namespace },
		spec: { podSelector: { matchLabels: { "app.kubernetes.io/name": "connection-api" } }, policyTypes: ["Egress"], egress },
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.length !== 3) throw new Error("Usage: node deploy/connection-network-policy.mjs <reviewed-dependencies.json>");
	console.log(JSON.stringify(connectionNetworkPolicy(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
}
