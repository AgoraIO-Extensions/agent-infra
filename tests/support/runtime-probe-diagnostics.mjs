const probeStages = new Set([
	"model-substitute",
	"provenance-rejection",
	"entrypoint-configuration-rejections",
	"default-turn",
	"execution-selection",
	"grant-rejections",
	"process-restart",
	"model-stop",
	"model-stop-request",
	"model-stop-close-before-confirmation",
	"model-stop-result",
	"model-stop-independent",
	"model-stop-target-open",
	"model-stop-independent-open",
	"model-stop-independent-closed",
	"model-stop-independent-release",
	"model-cancellation-request-closed",
	"model-cancellation",
	"model-cancellation-request",
	"model-cancellation-close-before-confirmation",
	"model-cancellation-result",
	"model-cancellation-status",
	"model-cancellation-restart",
	"recursive-native-storage-redaction",
	...[
		"default",
		"selected",
		"resumed",
		"stop",
		"stop-independent",
		"stop-follow-up",
		"cancel",
		"http-401",
		"http-403",
		"http-503",
		"redirect",
		"wrong-content-type",
		"response-failed",
		"response-incomplete",
		"error-event",
		"malformed",
		"oversized",
		"unterminated",
		"post-terminal",
		"unknown-event",
		"wrong-shape",
		"extra-error",
		"nested-error",
		"credential-echo",
	].flatMap((name) =>
		["submit", "events", "status", "failure", "stream-failure"].map(
			(suffix) => `${name}-${suffix}`,
		),
	),
]);
const probeCodes = new Set([
	"RUNTIME_CONFIGURATION_INVALID",
	"RUNTIME_CODEX_CONFIGURATION_INVALID",
	"RUNTIME_CODEX_PROTOCOL_INVALID",
	"RUNTIME_CODEX_PROVENANCE_MISMATCH",
	"RUNTIME_CODEX_STATE_INVALID",
	"RUNTIME_CODEX_UNAVAILABLE",
	"RUNTIME_DRIVER_INVALID",
	"RUNTIME_STARTUP_FAILED",
	"RUNTIME_GENERATION_CANCELLED",
	"RUNTIME_MODEL_SELECTION_UNSUPPORTED",
	"RUNTIME_REQUEST_INVALID",
	"RUNTIME_GRANT_INVALID",
	"RUNTIME_OPERATION_CONFLICT",
	"RUNTIME_SESSION_BINDING_MISMATCH",
	"RUNTIME_EXECUTION_BINDING_MISMATCH",
	"RUNTIME_FENCE_STALE",
	"RUNTIME_SESSION_NOT_FOUND",
	"RUNTIME_SESSION_UNAVAILABLE",
	"RUNTIME_SESSION_REQUIRED",
	"RUNTIME_TURN_NOT_ACTIVE",
]);

export function safeRuntimeProbeFailure(stderr) {
	if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 4096) return;
	let value;
	try {
		value = JSON.parse(stderr);
	} catch {
		return;
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.status !== "failed" ||
		Object.keys(value).some(
			(key) =>
				![
					"status",
					"stage",
					"startupCode",
					"httpStatus",
					"responseCode",
					"resultStatus",
					"isolationFileKind",
					"modelRequests",
					"authenticated",
				].includes(key),
		)
	)
		return;
	const safe = { status: "failed" };
	if (probeStages.has(value.stage)) safe.stage = value.stage;
	if (typeof value.authenticated === "boolean")
		safe.authenticated = value.authenticated;
	if (
		["running", "completed", "failed", "cancelled"].includes(value.resultStatus)
	)
		safe.resultStatus = value.resultStatus;
	for (const key of ["startupCode", "responseCode"])
		if (probeCodes.has(value[key])) safe[key] = value[key];
	if (
		Number.isInteger(value.httpStatus) &&
		value.httpStatus >= 100 &&
		value.httpStatus <= 599
	)
		safe.httpStatus = value.httpStatus;
	if (
		Number.isInteger(value.modelRequests) &&
		value.modelRequests >= 0 &&
		value.modelRequests <= 1000
	)
		safe.modelRequests = value.modelRequests;
	if (
		[
			"native-history:rollout",
			"native-history:other-jsonl",
			"native-database",
			"other",
		].includes(value.isolationFileKind)
	)
		safe.isolationFileKind = value.isolationFileKind;
	return JSON.stringify(safe);
}

export class ProbeStepFailure extends Error {
	constructor(diagnostic) {
		super("Runtime image probe step failed");
		this.diagnostic = Object.freeze(diagnostic);
	}
}

export async function probeStep(stage, operation, details = () => ({})) {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof ProbeStepFailure) throw error;
		let fields;
		try {
			fields = details();
		} catch {
			fields = {};
		}
		const serialized = safeRuntimeProbeFailure(
			JSON.stringify({ ...fields, status: "failed", stage }),
		);
		throw new ProbeStepFailure(
			serialized ? JSON.parse(serialized) : { status: "failed" },
		);
	}
}
