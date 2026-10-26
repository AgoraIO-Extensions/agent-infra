import {
	WorkloadPreflightRejectedErrorV1,
	type WorkloadStepFailureV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	classifyWorkloadStepFailureV1,
	createWorkloadStepFailureLoggerV1,
	WorkloadStepErrorV1,
} from "./workload-step-failure.js";

const failure = (
	overrides: Partial<WorkloadStepFailureV1> = {},
): WorkloadStepFailureV1 => ({
	agentId: "agent-a",
	phase: "applying",
	attempts: 1,
	terminal: false,
	error: new WorkloadKubernetesError("unavailable", {
		status: 403,
		kind: "Deployment",
		verb: "create",
	}),
	...overrides,
});

describe("classifyWorkloadStepFailureV1 (#2532)", () => {
	it.each([
		[401, "kubernetes_unauthorized"],
		[403, "kubernetes_forbidden"],
		[404, "kubernetes_not_found"],
		[400, "kubernetes_invalid"],
		[422, "kubernetes_invalid"],
		[429, "kubernetes_throttled"],
		[500, "kubernetes_server_error"],
		[503, "kubernetes_server_error"],
	] as const)("maps HTTP %s to %s", (status, reason) => {
		expect(
			classifyWorkloadStepFailureV1(
				new WorkloadKubernetesError("unavailable", {
					status,
					kind: "Job",
					verb: "get",
				}),
			),
		).toEqual({
			reason,
			kubernetes: { status, kind: "Job", verb: "get" },
		});
	});

	it("prioritizes the bounded quota marker over generic HTTP status", () => {
		expect(
			classifyWorkloadStepFailureV1(
				new WorkloadKubernetesError("unavailable", {
					status: 403,
					quota: true,
					kind: "PersistentVolumeClaim",
					verb: "create",
				}),
			),
		).toEqual({
			reason: "kubernetes_quota",
			kubernetes: {
				status: 403,
				quota: true,
				kind: "PersistentVolumeClaim",
				verb: "create",
			},
		});
	});

	it("separates conflicts, policy refusals and calls without an HTTP response", () => {
		expect(
			classifyWorkloadStepFailureV1(new WorkloadKubernetesError("conflict")),
		).toEqual({ reason: "kubernetes_conflict", kubernetes: {} });
		expect(
			classifyWorkloadStepFailureV1(new WorkloadKubernetesError("policy")),
		).toEqual({ reason: "kubernetes_policy", kubernetes: {} });
		expect(
			classifyWorkloadStepFailureV1(
				new WorkloadKubernetesError("unavailable", {
					kind: "Pod",
					verb: "list",
				}),
			),
		).toEqual({
			reason: "kubernetes_unreachable",
			kubernetes: { kind: "Pod", verb: "list" },
		});
	});

	it("classifies permanent model binding mismatches without exposing error text", () => {
		class ModelConfigurationErrorV1 extends Error {
			readonly retryable = false;
		}
		expect(
			classifyWorkloadStepFailureV1(
				new ModelConfigurationErrorV1(
					"model endpoint or credential details must not be logged",
				),
			),
		).toEqual({ reason: "configuration_mismatch" });
	});

	it("recognises the known bounded errors", () => {
		expect(
			classifyWorkloadStepFailureV1(new WorkloadPreflightRejectedErrorV1()),
		).toEqual({ reason: "preflight_rejected" });
		expect(
			classifyWorkloadStepFailureV1(
				new WorkloadStepErrorV1(
					"capabilities_unavailable",
					"Runtime capabilities are unavailable",
				),
			),
		).toEqual({ reason: "capabilities_unavailable" });
	});

	it("keeps the preflight boundary in the sanitized record", () => {
		const classified = classifyWorkloadStepFailureV1(
			new WorkloadPreflightRejectedErrorV1("model-projection"),
		);
		expect(classified).toEqual({
			reason: "preflight_rejected",
			preflightStage: "model-projection",
		});
		const log = vi.fn();
		createWorkloadStepFailureLoggerV1({ log })(
			failure({
				phase: "preflight",
				error: new WorkloadPreflightRejectedErrorV1("registry-admission"),
				terminal: true,
			}),
		);
		expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({
			reason: "preflight_rejected",
			preflightStage: "registry-admission",
		});
	});

	it("never reads the message of an unknown error, only a filtered class name", () => {
		class RegistryTimeoutError extends Error {}
		const classified = classifyWorkloadStepFailureV1(
			new RegistryTimeoutError("https://user:secret@registry.example/v2"),
		);
		expect(classified).toEqual({
			reason: "unexpected_error",
			errorName: "RegistryTimeoutError",
		});
		expect(JSON.stringify(classified)).not.toContain("secret");
		expect(classifyWorkloadStepFailureV1("plain string")).toEqual({
			reason: "unexpected_error",
		});
		expect(classifyWorkloadStepFailureV1(null)).toEqual({
			reason: "unexpected_error",
		});
	});
});

describe("createWorkloadStepFailureLoggerV1 (#2532)", () => {
	it("logs a bounded record with the Kubernetes status, kind and verb", () => {
		const log = vi.fn();
		createWorkloadStepFailureLoggerV1({ log })(failure({ attempts: 7 }));
		expect(log).toHaveBeenCalledOnce();
		expect(JSON.parse(log.mock.calls[0]?.[0])).toEqual({
			service: "platform-worker",
			code: "WORKLOAD_STEP_FAILED",
			agentId: "agent-a",
			phase: "applying",
			attempts: 7,
			terminal: false,
			reason: "kubernetes_forbidden",
			kubernetes: { status: 403, kind: "Deployment", verb: "create" },
		});
	});

	it("keeps provider text and credentials out of the record", () => {
		const log = vi.fn();
		const error = Object.assign(
			new Error("password=hunter2 https://token@internal.example"),
			{ body: 'secret "agent-private-name" forbidden', code: 403 },
		);
		createWorkloadStepFailureLoggerV1({ log })(failure({ error }));
		const text = String(log.mock.calls[0]?.[0]);
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("internal.example");
		expect(text).not.toContain("agent-private-name");
		expect(JSON.parse(text)).toMatchObject({
			reason: "unexpected_error",
			errorName: "Error",
		});
	});

	it("logs once per interval for the same agent, phase and reason and counts the rest", () => {
		const log = vi.fn();
		let now = 1_000;
		const report = createWorkloadStepFailureLoggerV1({
			log,
			intervalMs: 30_000,
			now: () => now,
		});
		report(failure({ attempts: 1 }));
		for (let i = 2; i <= 6; i++) {
			now += 3_000;
			report(failure({ attempts: i }));
		}
		expect(log).toHaveBeenCalledOnce();
		now += 20_000; // 距离第一条已超过 30 s
		report(failure({ attempts: 7 }));
		expect(log).toHaveBeenCalledTimes(2);
		expect(JSON.parse(log.mock.calls[1]?.[0])).toMatchObject({
			attempts: 7,
			suppressed: 5,
		});
	});

	it("keeps agents, phases and reasons apart and always logs a terminal failure", () => {
		const log = vi.fn();
		const report = createWorkloadStepFailureLoggerV1({
			log,
			intervalMs: 30_000,
			now: () => 1_000,
		});
		report(failure());
		report(failure({ agentId: "agent-b" }));
		report(failure({ phase: "promoting" }));
		report(
			failure({
				error: new WorkloadKubernetesError("unavailable", {
					status: 500,
					kind: "Deployment",
					verb: "create",
				}),
			}),
		);
		expect(log).toHaveBeenCalledTimes(4);
		report(failure({ terminal: true, attempts: 60 }));
		expect(log).toHaveBeenCalledTimes(5);
		expect(JSON.parse(log.mock.calls[4]?.[0])).toMatchObject({
			terminal: true,
			attempts: 60,
		});
	});

	it("bounds its own memory", () => {
		const log = vi.fn();
		let now = 0;
		const report = createWorkloadStepFailureLoggerV1({
			log,
			intervalMs: 1_000,
			now: () => now,
			maximumKeys: 10,
		});
		for (let i = 0; i < 100; i++) {
			now += 1;
			report(failure({ agentId: `agent-${i}` }));
		}
		expect(log).toHaveBeenCalledTimes(100);
		// 最旧的键被丢弃后，同一个 Agent 再失败会重新记录，而不是无限占内存。
		report(failure({ agentId: "agent-0" }));
		expect(log).toHaveBeenCalledTimes(101);
	});
});
