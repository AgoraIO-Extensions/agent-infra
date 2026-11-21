import {
	RuntimeHostError,
	RuntimeSafetyEvidenceLogV1,
} from "@agent-infra/agent-runtime";
import {
	RuntimeSafetyEvidenceLogAckRequestV1Schema,
	RuntimeSafetyEvidenceLogAckResponseV1Schema,
	RuntimeSafetyEvidenceLogReadRequestV1Schema,
	RuntimeSafetyEvidenceLogReadResponseV1Schema,
	type RuntimeSafetyEvidenceWindowV1,
	RuntimeSafetyEvidenceWindowV1Schema,
} from "@agent-infra/contracts/runtime";
import type { Hono } from "hono";

/** Deployment-injected window (Spec §18.5.1 验收场景); absent means the evidence log is off. */
export const runtimeSafetyEvidenceWindowEnvironmentV1 =
	"AGENT_INFRA_RUNTIME_SAFETY_EVIDENCE_WINDOW";
const maximumWindowBytes = 32_768;

export type RuntimeSafetyEvidenceWindowConfigurationV1 =
	| { readonly status: "disabled" }
	/** Fixed diagnostic only: the Host keeps serving business with evidence off. */
	| { readonly status: "invalid" }
	| { readonly status: "enabled"; readonly window: RuntimeSafetyEvidenceWindowV1 };

export function readRuntimeSafetyEvidenceWindowV1(
	environment: NodeJS.ProcessEnv,
): RuntimeSafetyEvidenceWindowConfigurationV1 {
	const value = environment[runtimeSafetyEvidenceWindowEnvironmentV1];
	if (value === undefined) return { status: "disabled" };
	if (Buffer.byteLength(value) > maximumWindowBytes)
		return { status: "invalid" };
	try {
		const parsed = RuntimeSafetyEvidenceWindowV1Schema.safeParse(
			JSON.parse(value),
		);
		return parsed.success
			? { status: "enabled", window: parsed.data }
			: { status: "invalid" };
	} catch {
		return { status: "invalid" };
	}
}

export interface RuntimeSafetyEvidenceAssemblyV1 {
	readonly window: RuntimeSafetyEvidenceWindowV1;
	readonly log: RuntimeSafetyEvidenceLogV1;
}

/**
 * Opens the separate evidence log only for an enabled window. Any failure leaves evidence off
 * with one fixed diagnostic code and never fails Host startup or business.
 */
export async function openRuntimeSafetyEvidenceV1(input: {
	readonly environment: NodeJS.ProcessEnv;
	readonly path: string;
	readonly logDiagnostic: (entry: Record<string, string>) => void;
}): Promise<RuntimeSafetyEvidenceAssemblyV1 | undefined> {
	const configuration = readRuntimeSafetyEvidenceWindowV1(input.environment);
	if (configuration.status === "disabled") return undefined;
	if (configuration.status === "invalid") {
		input.logDiagnostic({
			service: "agent-runtime-host",
			code: "RUNTIME_SAFETY_EVIDENCE_WINDOW_INVALID",
		});
		return undefined;
	}
	try {
		return {
			window: configuration.window,
			log: await RuntimeSafetyEvidenceLogV1.open({ path: input.path }),
		};
	} catch {
		input.logDiagnostic({
			service: "agent-runtime-host",
			code: "RUNTIME_SAFETY_EVIDENCE_UNAVAILABLE",
		});
		return undefined;
	}
}

interface Parser<T> {
	safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function parseBody<T>(request: Request, parser: Parser<T>) {
	const value = await request.json().catch(() => undefined);
	const parsed = parser.safeParse(value);
	if (!parsed.success)
		throw new RuntimeHostError(
			"RUNTIME_REQUEST_INVALID",
			"Runtime request is invalid",
			400,
		);
	return parsed.data;
}

/**
 * Registers the evidence log read and ACK on the Host's existing service port, behind the same
 * service-token middleware. Nothing is registered while no window is configured, so the Session
 * Service shape and the Worker route resolution stay as they are.
 */
export function registerRuntimeSafetyEvidenceRoutesV1(
	app: Hono,
	log: Pick<RuntimeSafetyEvidenceLogV1, "read" | "acknowledge">,
) {
	app.post("/internal/runtime/v1/safety-evidence/read", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeSafetyEvidenceLogReadRequestV1Schema,
		);
		return context.json(
			RuntimeSafetyEvidenceLogReadResponseV1Schema.parse({
				schemaVersion: 1,
				entries: await log.read({
					after: request.after,
					limit: request.limit,
				}),
			}),
		);
	});
	app.post("/internal/runtime/v1/safety-evidence/ack", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeSafetyEvidenceLogAckRequestV1Schema,
		);
		return context.json(
			RuntimeSafetyEvidenceLogAckResponseV1Schema.parse({
				schemaVersion: 1,
				acknowledged: await log.acknowledge(request.cursor),
			}),
		);
	});
}
