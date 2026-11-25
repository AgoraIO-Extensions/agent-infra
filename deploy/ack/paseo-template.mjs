/** The preflight must identify the SDK route that actually served this template. */
export function paseoTemplateEvidence(template, transport) {
	if (template === "pi" && (transport === "paseo-sdk" || transport === "paseo-sdk-pod")) return "original-pi-driver-session";
	if (template === "opencode" && transport === "paseo-sdk-pod") return "original-acp-driver-session";
	throw new Error("PREFLIGHT_TRANSPORT_INVALID");
}
