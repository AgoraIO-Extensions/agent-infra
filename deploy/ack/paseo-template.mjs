const sdkTemplates = new Map([
	["pi", { driver: "pi", protocol: "anthropic-messages-v1", evidence: "original-pi-driver-session", companionName: "pi-paseo", journalDirectory: "pi-driver" }],
	["opencode", { driver: "acp", protocol: "anthropic-messages-v1", evidence: "original-acp-driver-session", companionName: "opencode-paseo", journalDirectory: "acp-driver" }],
	["codex", { driver: "codex", protocol: "openai-responses-v1", evidence: "original-codex-driver-session", companionName: "pi-paseo", journalDirectory: "codex-paseo-driver" }],
]);

/** The preflight must use the provider and protocol that actually serve this SDK route. */
export function paseoTemplateBinding(template, transport) {
	const binding = sdkTemplates.get(template);
	if (!binding || (transport !== "paseo-sdk-pod" && !(template === "pi" && transport === "paseo-sdk")))
		throw new Error("PREFLIGHT_TRANSPORT_INVALID");
	return binding;
}

export function paseoTemplateEvidence(template, transport) {
	return paseoTemplateBinding(template, transport).evidence;
}
