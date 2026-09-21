import { pathToFileURL } from "node:url";

export async function verifyProductionReads({ endpoint, fetch, probes, token }) {
	let id = 0;
	const call = async (name, args) => {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw new Error(`Connection returned HTTP ${response.status}`);
		const payload = await response.json();
		if (payload.error) throw new Error(payload.error.message ?? "Connection MCP error");
		return payload.result?.structuredContent;
	};
	const results = [];
	for (const probe of probes) {
		if (!probe.actionId.startsWith(`${probe.service}.`)) {
			throw new Error(`${probe.actionId} does not belong to ${probe.service}`);
		}
		const connections = await call("list_connections", { service: probe.service });
		const active = connections?.connections?.filter((item) => item.status === "ACTIVE") ?? [];
		if (active.length === 0) {
			throw new Error(`No active ${probe.service} connection`);
		}
		const guide = await call("get_action_guide", { actionId: probe.actionId });
		if (
			guide?.action?.actionId !== probe.actionId ||
			guide.action.effect !== "READ" ||
			!guide.action.actionVersionId?.startsWith(`${probe.actionId}@`) ||
			!active.some((item) => item.actionVersionIds?.includes(guide.action.actionVersionId))
		) {
			throw new Error(`${probe.actionId} is not an authorized ${probe.service} READ`);
		}
		const execution = await call("execute_action", { actionId: probe.actionId, input: probe.input });
		if (execution?.status !== "SUCCEEDED") throw new Error(`${probe.actionId} did not succeed`);
		results.push({ actionVersionId: guide.action.actionVersionId, callId: execution.callId, service: probe.service });
	}
	return results;
}

async function main() {
	const endpoint = process.env.CONNECTION_PRODUCTION_MCP_URL?.trim();
	const token = process.env.CONNECTION_PRODUCTION_TOKEN?.trim();
	const probes = JSON.parse(process.env.CONNECTION_PRODUCTION_READ_PROBES ?? "[]");
	if (!endpoint || !token || !Array.isArray(probes) || probes.length === 0) {
		throw new Error("Production endpoint, token, and READ probes are required");
	}
	process.stdout.write(`${JSON.stringify(await verifyProductionReads({ endpoint, fetch, probes, token }))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
