import {
	createReadToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** Register only the pinned native read tool, with all filesystem reads mediated by Host. */
export default function piSkillRead(pi: ExtensionAPI) {
	const endpoint = process.env.AGENT_INFRA_PI_SKILL_READER;
	const token = process.env.AGENT_INFRA_PI_MODEL_TOKEN;
	const workspace = process.env.AGENT_INFRA_PI_WORKSPACE;
	if (
		!workspace ||
		!token ||
		!endpoint ||
		!/^http:\/\/127\.0\.0\.1:\d+\/pi\/skill-read$/.test(endpoint)
	)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const read = createReadToolDefinition(workspace, {
		operations: {
			// The Host checks existence and permissions in the same authorized operation.
			access: async () => {},
			async readFile(path) {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: { "x-api-key": token },
					body: path,
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
				return Buffer.from(await response.arrayBuffer());
			},
		},
	});
	pi.registerTool(read);
}
