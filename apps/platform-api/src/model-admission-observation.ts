import { LdapIdentityUnavailableError } from "@agent-infra/identity";
import type { RelayStageObservationV1 } from "@agent-infra/model-catalog";
import { recordHttpDependency } from "@agent-infra/observability/http";
import { PersonalApiCredentialErrorV1 } from "@agent-infra/platform-core";
import { HttpProtocolError } from "./http/common.js";

export function recordRelayStage(event: RelayStageObservationV1): void {
	const { stage, ...facts } = event;
	recordHttpDependency({ operationRef: `model.admission.${stage}`, ...facts });
}

export async function observeModelAdmissionIdentity<T>(
	resolve: () => Promise<T>,
	stage:
		| "identity"
		| "identity.owner"
		| "identity.references"
		| "identity.authority"
		| "identity.credential_recheck"
		| "identity.commit_recheck" = "identity",
): Promise<T> {
	const began = performance.now();
	let outcome: "completed" | "rejected" | "failed" = "completed";
	let termination: "timeout" | undefined;
	try {
		return await resolve();
	} catch (error) {
		outcome =
			(error instanceof HttpProtocolError && error.status < 500) ||
			(error instanceof PersonalApiCredentialErrorV1 &&
				(error.code === "authentication_required" ||
					error.code === "forbidden" ||
					error.code === "not_found"))
				? "rejected"
				: "failed";
		const cause = error instanceof Error ? error.cause : undefined;
		if (
			[error, cause].some(
				(item) =>
					(item instanceof DOMException && item.name === "TimeoutError") ||
					(item instanceof LdapIdentityUnavailableError &&
						item.failure?.deadlineExpired),
			)
		)
			termination = "timeout";
		throw error;
	} finally {
		recordHttpDependency({
			operationRef: `model.admission.${stage}`,
			outcome,
			durationMs: performance.now() - began,
			...(termination === undefined ? {} : { termination }),
		});
	}
}
