import { describe, expect, it } from "vitest";
import {
	classifyExecutionFailureV1,
	type ExecutionFailureCategoryV1,
	executionFailureCategoriesV1,
	executionFailureCategoryForCodeV1,
	executionFailureMessageV1,
} from "./execution-failure.js";

/** 码到分类的完整对照（工程 Spec §16.1.1）；新增码须先在这里确定分类。 */
const table: readonly (readonly [string, ExecutionFailureCategoryV1])[] = [
	["PROVIDER_RATE_LIMITED", "model_unavailable"],
	["MODEL_STREAM_IDLE_TIMEOUT", "model_unavailable"],
	["RUNTIME_MODEL_ACCESS_CAPACITY", "model_unavailable"],
	["RUNTIME_MODEL_DRAIN_FAILED", "model_unavailable"],
	["RUNTIME_MODEL_STREAM_INVALID", "model_unavailable"],
	["AGENT_UNAVAILABLE", "agent_updating"],
	["AGENT_UPDATING", "agent_updating"],
	["AGENT_STARTING", "agent_updating"],
	["RUNTIME_SESSION_PREPARATION_FAILED", "session_preparation_failed"],
	["RUNTIME_DRIVER_INVALID", "session_preparation_failed"],
	["RUNTIME_DRIVER_RECOVERY_FAILED", "session_preparation_failed"],
	["RUNTIME_STARTUP_FAILED", "session_preparation_failed"],
	["RUNTIME_ACP_HANDSHAKE_TIMEOUT", "session_preparation_failed"],
	["RUNTIME_ACP_HANDSHAKE_INTERRUPTED", "session_preparation_failed"],
	["RUNTIME_CODEX_UNAVAILABLE", "session_preparation_failed"],
	["RUNTIME_NATIVE_SESSION_UNAVAILABLE", "session_preparation_failed"],
	["RUNTIME_WORKLOAD_UNAVAILABLE", "session_preparation_failed"],
	["RUNTIME_FILE_INPUT_UNAVAILABLE", "attachment_unreadable"],
	["RUNTIME_FILE_INPUT_REJECTED", "attachment_unreadable"],
	["RUNTIME_FILE_INPUT_SIZE_MISMATCH", "attachment_unreadable"],
	["RUNTIME_FILE_BRIDGE_CONTEXT_EXPIRED", "attachment_unreadable"],
	["RUNTIME_FILE_EXCHANGE_UNAVAILABLE", "attachment_unreadable"],
	["AUTHORIZATION_REVOKED", "authorization_revoked"],
	["AUTHORIZATION_DENIED", "authorization_revoked"],
	["RUNTIME_AUTHORIZATION_DENIED", "authorization_revoked"],
	["RELAY_KEY_UNAVAILABLE", "relay_key_unavailable"],
	["RELAY_KEY_AUTHENTICATION_FAILED", "relay_key_unavailable"],
	["RELAY_KEY_METADATA_INVALID", "relay_key_unavailable"],
	["RELAY_KEY_VALIDATION_FAILED", "relay_key_unavailable"],
	["SAVED_RELAY_KEY_UNAVAILABLE", "relay_key_unavailable"],
	["SAVED_RELAY_KEY_BINDING_INVALID", "relay_key_unavailable"],
	["RUNTIME_MODEL_CREDENTIAL_INVALID", "relay_key_unavailable"],
	["TASK_WAIT_TIMEOUT", "queue_timeout"],
	["CONVERSATION_UNAVAILABLE", "conversation_unavailable"],
	["RUNTIME_SESSION_BLOCKED", "conversation_unavailable"],
	["RUNTIME_SESSION_RECOVERY_FAILED", "conversation_unavailable"],
	["RUNTIME_SESSION_RECOVERY_BLOCKED", "conversation_unavailable"],
	["RUNTIME_SESSION_QUARANTINED", "conversation_unavailable"],
	["RUNTIME_RECOVERY_TIMEOUT", "internal_error"],
	["RUNTIME_INTERNAL_ERROR", "internal_error"],
];

describe("executionFailureCategoryForCodeV1", () => {
	it.each(table)("maps %s to exactly one category", (code, category) => {
		expect(executionFailureCategoryForCodeV1(code)).toBe(category);
	});

	it("leaves unclassified codes to the next source instead of guessing", () => {
		for (const code of [
			"RUNTIME_EXECUTION_FAILED",
			"RUNTIME_UNAVAILABLE",
			"RUNTIME_FILE_INPUT_",
			"runtime_file_input_unavailable",
			"constructor",
			"",
		])
			expect(executionFailureCategoryForCodeV1(code)).toBeNull();
	});
});

describe("classifyExecutionFailureV1", () => {
	it("covers every category with at least one persisted source", () => {
		const covered = new Set([
			classifyExecutionFailureV1({
				modelFailureCode: "dependency_unavailable",
			}),
			...table.map(([code]) =>
				classifyExecutionFailureV1({ dispatchCode: code }),
			),
			classifyExecutionFailureV1({}),
		]);
		expect([...covered].sort()).toEqual(
			[...executionFailureCategoriesV1].sort(),
		);
	});

	it("prefers the task reason, then a now-unavailable conversation", () => {
		expect(
			classifyExecutionFailureV1({
				taskReason: "TASK_WAIT_TIMEOUT",
				conversationUnavailable: true,
				dispatchCode: "RUNTIME_DRIVER_INVALID",
			}),
		).toBe("queue_timeout");
		expect(
			classifyExecutionFailureV1({
				conversationUnavailable: true,
				dispatchCode: "RUNTIME_FILE_INPUT_UNAVAILABLE",
			}),
		).toBe("conversation_unavailable");
	});

	it("falls through unclassified codes to the next persisted source", () => {
		expect(
			classifyExecutionFailureV1({
				dispatchCode: "RUNTIME_EXECUTION_FAILED",
				runtimeCode: "RUNTIME_FILE_INPUT_UNAVAILABLE",
			}),
		).toBe("attachment_unreadable");
		expect(
			classifyExecutionFailureV1({
				runtimeCode: "RUNTIME_EXECUTION_FAILED",
				modelFailureCode: "response_incomplete",
			}),
		).toBe("model_unavailable");
		expect(
			classifyExecutionFailureV1({ modelFailureCode: "authorization_denied" }),
		).toBe("authorization_revoked");
		// 明确归入内部错误的码不再被更弱的来源覆盖。
		expect(
			classifyExecutionFailureV1({
				dispatchCode: "RUNTIME_RECOVERY_TIMEOUT",
				modelFailureCode: "dependency_unavailable",
			}),
		).toBe("internal_error");
	});

	it("treats unknown or missing facts as an internal error", () => {
		expect(classifyExecutionFailureV1({})).toBe("internal_error");
		expect(
			classifyExecutionFailureV1({
				taskReason: "SOMETHING_NEW",
				dispatchCode: "SOMETHING_NEW",
				runtimeCode: null,
				modelFailureCode: "something_new",
			}),
		).toBe("internal_error");
	});
});

describe("executionFailureMessageV1", () => {
	it("gives every category an actionable message without codes", () => {
		for (const category of executionFailureCategoriesV1) {
			const message = executionFailureMessageV1(category, "trace-1");
			expect(message.length).toBeGreaterThan(0);
			expect(message).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
		}
		expect(executionFailureMessageV1("model_unavailable")).toBe(
			"模型服务暂时繁忙或超时，请稍后重试",
		);
		expect(executionFailureMessageV1("relay_key_unavailable")).toContain(
			"个人设置",
		);
		expect(executionFailureMessageV1("conversation_unavailable")).toContain(
			"新建会话",
		);
	});

	it("attaches the trace only to internal errors", () => {
		expect(executionFailureMessageV1("internal_error", "trace-1")).toBe(
			"平台内部错误，反馈时请提供追踪编号 trace-1",
		);
		expect(executionFailureMessageV1("internal_error")).toBe(
			"平台内部错误，请稍后重试",
		);
		expect(
			executionFailureMessageV1("agent_updating", "trace-1"),
		).not.toContain("trace-1");
	});
});
