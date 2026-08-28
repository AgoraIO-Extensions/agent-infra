import { describe, expect, it } from "vitest";
import { createDocument } from "zod-openapi";

import {
	AgentApplicationCreateRequestV1Schema,
	AgentApplicationProjectionV1Schema,
	AgentApplicationUpdateRequestV1Schema,
	AgentConfigurationProjectionV1Schema,
	AgentConfigurationUpdateRequestV1Schema,
	AgentLifecycleCommandRequestV1Schema,
	AgentProjectionV1Schema,
	BrowserSessionProjectionV1Schema,
	ExecutionDetailProjectionV1Schema,
	MessageCommandRequestV1Schema,
	MessageProjectionV1Schema,
	PlatformAuditProjectionV1Schema,
	pilotBrowserOpenApiPathsV1,
} from "../../src/pilot/browser.js";

const requiredOperations = [
	"getCurrentSession",
	"listAgentApplications",
	"createAgentApplication",
	"getAgentApplication",
	"updateAgentApplication",
	"withdrawAgentApplication",
	"listPendingAgentApplications",
	"decideAgentApplication",
	"listAgents",
	"getAgent",
	"updateAgentConfiguration",
	"commandAgentLifecycle",
	"listConversations",
	"createConversation",
	"getConversation",
	"submitMessage",
	"regenerateAnswer",
	"stopExecution",
	"updateConversationModelSelection",
	"getExecutionDetail",
	"listPlatformAudit",
	"streamConversationEvents",
];

const validApplication = {
	schemaVersion: 1,
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	coOwnerIds: ["user-co-owner"],
	availability: [{ kind: "organization", organizationId: "org-platform" }],
	modelConfiguration: {
		options: [
			{
				optionId: "model-primary",
				endpointId: "endpoint-approved",
				modelId: "gpt-5",
				reasoningLevels: ["medium", "high"],
				credentialValue: "one-time-input",
			},
		],
		defaultOptionId: "model-primary",
		defaultReasoningLevel: "medium",
	},
	actions: [
		{ providerId: "github", actionId: "issues.read", actionVersion: "v3" },
	],
	environment: [{ name: "WORKSPACE_NAME", value: "release" }],
	secrets: [{ name: "MODEL_API_KEY", value: "one-time-input" }],
};

describe("Pilot browser contracts", () => {
	it("publishes the complete approved management and text-conversation journey", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: { title: "Pilot browser API", version: "1.0.0" },
			paths: pilotBrowserOpenApiPathsV1,
		});
		const operations = Object.values(document.paths ?? {})
			.flatMap((path) => Object.values(path ?? {}))
			.flatMap((operation) =>
				operation && typeof operation === "object" && "operationId" in operation
					? [operation.operationId]
					: [],
			);

		expect(operations.sort()).toEqual(requiredOperations.sort());
		for (const path of Object.values(document.paths ?? {})) {
			for (const operation of Object.values(path ?? {})) {
				if (
					!operation ||
					typeof operation !== "object" ||
					!("responses" in operation)
				)
					continue;
				expect(operation.responses).toHaveProperty("500");
				expect(JSON.stringify(operation.responses["500"])).toContain(
					"INTERNAL_ERROR",
				);
				if ("requestBody" in operation) {
					expect(operation.requestBody).toMatchObject({ required: true });
				}
			}
		}
		const serialized = JSON.stringify(document);
		for (const forbiddenProperty of [
			"issuer",
			"subject",
			"identityContext",
			"kubernetesObject",
			"connectionId",
			"secretPlaintext",
		]) {
			expect(serialized).not.toContain(`"${forbiddenProperty}"`);
		}
		expect(
			AgentProjectionV1Schema.shape.interactionUrl.safeParse(
				"javascript:alert(1)",
			).success,
		).toBe(false);
		expect(
			AgentProjectionV1Schema.shape.interactionUrl.safeParse(
				"https://user:password@agent.example.test",
			).success,
		).toBe(false);
		expect(
			AgentProjectionV1Schema.shape.interactionUrl.safeParse(
				"https://agent.example.test",
			).success,
		).toBe(true);
	});

	it("accepts product inputs while rejecting caller-supplied identity and authorization", () => {
		expect(
			AgentApplicationCreateRequestV1Schema.parse(validApplication),
		).toEqual(validApplication);
		expect(
			AgentApplicationCreateRequestV1Schema.safeParse({
				...validApplication,
				actorId: "caller-controlled",
			}).success,
		).toBe(false);
		expect(
			MessageCommandRequestV1Schema.safeParse({
				schemaVersion: 1,
				text: "ship it",
				actorId: "caller-controlled",
				connectionId: "another-users-connection",
			}).success,
		).toBe(false);
		expect(
			AgentApplicationCreateRequestV1Schema.safeParse({
				...validApplication,
				source: {
					kind: "custom",
					imageReference: "registry.example/agent:v1",
					interactionMode: "self-managed",
				},
			}).success,
		).toBe(false);
		expect(
			AgentApplicationCreateRequestV1Schema.safeParse({
				...validApplication,
				source: {
					kind: "custom",
					imageReference: "registry.example/agent:v1",
					interactionMode: "platform-adapter",
					identityResponsibility: "platform-managed",
				},
			}).success,
		).toBe(false);
	});

	it("keeps trusted identity and secret values out of browser projections", () => {
		expect(
			BrowserSessionProjectionV1Schema.safeParse({
				schemaVersion: 1,
				user: {
					userId: "user-1",
					displayName: "Ada",
					roles: ["employee"],
					issuer: "internal-idp",
					subject: "upstream-subject",
				},
			}).success,
		).toBe(false);
		expect(
			AgentConfigurationUpdateRequestV1Schema.safeParse({
				schemaVersion: 1,
				secretPlaintext: "not-a-supported-field",
			}).success,
		).toBe(false);
		expect(
			AgentConfigurationProjectionV1Schema.safeParse({
				owners: [{ userId: "user-1", displayName: "Ada", roles: ["employee"] }],
				availability: [],
				modelOptions: [],
				defaultModelOptionId: null,
				defaultReasoningLevel: null,
				actions: [],
				environment: [],
				channels: [],
				secrets: [
					{ name: "MODEL_API_KEY", isSet: true, version: 1, value: "leak" },
				],
			}).success,
		).toBe(false);
		expect(
			AgentApplicationUpdateRequestV1Schema.safeParse({
				...validApplication,
				secrets: undefined,
			}).success,
		).toBe(true);
		expect(
			AgentApplicationCreateRequestV1Schema.safeParse({
				...validApplication,
				secrets: undefined,
			}).success,
		).toBe(false);
	});

	it("models channel binding and custom image upgrades without exposing credentials", () => {
		expect(
			AgentConfigurationUpdateRequestV1Schema.parse({
				schemaVersion: 1,
				channels: [
					{
						kind: "wecom_bot",
						enabled: true,
						bindingReference: "binding-1",
					},
				],
			}),
		).toMatchObject({ schemaVersion: 1 });
		expect(
			AgentConfigurationUpdateRequestV1Schema.safeParse({
				schemaVersion: 1,
				channels: [{ kind: "wecom_bot", enabled: true }],
			}).success,
		).toBe(false);
		expect(
			AgentConfigurationUpdateRequestV1Schema.parse({
				schemaVersion: 1,
				channels: [{ kind: "wecom_bot", enabled: false }],
			}),
		).toMatchObject({ schemaVersion: 1 });
		expect(
			AgentLifecycleCommandRequestV1Schema.parse({
				schemaVersion: 1,
				command: "upgrade_custom_image",
				imageReference: "registry.example/agent:v2",
			}),
		).toMatchObject({ command: "upgrade_custom_image" });
		expect(
			AgentLifecycleCommandRequestV1Schema.safeParse({
				schemaVersion: 1,
				command: "upgrade_custom_image",
			}).success,
		).toBe(false);
	});

	it("carries an approved application through the full management status journey", () => {
		const application = {
			schemaVersion: 1,
			applicationId: "application-1",
			agentId: "agent-1",
			name: "Release assistant",
			description: "Helps the release team",
			source: { kind: "standard", templateId: "codex" },
			status: "creating",
			resourceProfile: {
				profileId: "standard-medium",
				displayName: "Standard medium",
				estimatedResources: {
					cpuMillicores: 2000,
					memoryMiB: 4096,
					storageGiB: 20,
				},
			},
			configuration: {
				owners: [{ userId: "user-1", displayName: "Ada", roles: ["employee"] }],
				availability: [],
				modelOptions: [],
				defaultModelOptionId: null,
				defaultReasoningLevel: null,
				actions: [],
				environment: [],
				channels: [{ kind: "web", status: "available" }],
				secrets: [],
			},
			submittedAt: "2026-08-28T10:00:00Z",
			decision: {
				decidedAt: "2026-08-28T10:01:00Z",
				reason: null,
			},
		};

		expect(AgentApplicationProjectionV1Schema.parse(application)).toEqual(
			application,
		);
		expect(
			AgentApplicationCreateRequestV1Schema.safeParse({
				...validApplication,
				resourceProfile: application.resourceProfile,
			}).success,
		).toBe(false);
		expect(
			AgentApplicationProjectionV1Schema.safeParse({
				...application,
				resourceProfile: {
					...application.resourceProfile,
					estimatedResources: {
						...application.resourceProfile.estimatedResources,
						cpuMillicores: 0,
					},
				},
			}).success,
		).toBe(false);
	});

	it("projects answer versions and actual model or Connection execution records", () => {
		expect(
			MessageProjectionV1Schema.parse({
				messageId: "message-answer-2",
				role: "assistant",
				text: "Regenerated answer",
				status: "completed",
				executionId: "execution-2",
				replyToMessageId: "message-user-1",
				answerVersion: 2,
				isCurrentAnswer: true,
				error: null,
				createdAt: "2026-08-28T10:02:00Z",
			}),
		).toMatchObject({ answerVersion: 2, isCurrentAnswer: true });
		for (const code of [
			"ORIGINAL_RESPONSE_NOT_STARTED",
			"ORIGINAL_RESPONSE_ALREADY_FINISHED",
			"AUTHORIZATION_REVOKED",
			"EXECUTION_FAILED",
		] as const) {
			expect(
				MessageProjectionV1Schema.parse({
					messageId: `message-${code}`,
					role: "user",
					text: "Supplementary instruction",
					status: "failed",
					executionId: "execution-2",
					replyToMessageId: null,
					answerVersion: null,
					isCurrentAnswer: null,
					error: {
						schemaVersion: 1,
						code,
						message: "The message could not be delivered",
						retryable: false,
						traceId: "trace-message",
					},
					createdAt: "2026-08-28T10:02:00Z",
				}),
			).toMatchObject({ status: "failed", error: { code } });
		}
		expect(
			MessageProjectionV1Schema.safeParse({
				messageId: "message-invalid-error",
				role: "assistant",
				text: "Completed answer",
				status: "completed",
				executionId: "execution-2",
				replyToMessageId: "message-user-1",
				answerVersion: 1,
				isCurrentAnswer: true,
				error: {
					schemaVersion: 1,
					code: "EXECUTION_FAILED",
					message: "Contradictory error",
					retryable: false,
					traceId: "trace-message",
				},
				createdAt: "2026-08-28T10:02:00Z",
			}).success,
		).toBe(false);
		expect(
			MessageProjectionV1Schema.safeParse({
				messageId: "message-missing-error",
				role: "user",
				text: "Supplementary instruction",
				status: "failed",
				executionId: "execution-2",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: null,
				createdAt: "2026-08-28T10:02:00Z",
			}).success,
		).toBe(false);
		expect(
			ExecutionDetailProjectionV1Schema.parse({
				schemaVersion: 1,
				executionId: "execution-2",
				conversationId: "conversation-1",
				status: "completed",
				processSummary: [
					{
						occurredAt: "2026-08-28T10:01:00Z",
						kind: "model_call",
						modelId: "gpt-5",
						reasoningLevel: "medium",
						status: "succeeded",
						summary: "Model call completed",
					},
					{
						occurredAt: "2026-08-28T10:01:30Z",
						kind: "connection_call",
						callId: "call-1",
						providerId: "github",
						accountDisplay: "org/repository",
						actionId: "issues.read",
						actionVersion: "v3",
						status: "succeeded",
						summary: "Issue read completed",
					},
				],
				startedAt: "2026-08-28T10:00:00Z",
				finishedAt: "2026-08-28T10:02:00Z",
				error: null,
			}),
		).toMatchObject({ status: "completed" });
		expect(
			ExecutionDetailProjectionV1Schema.safeParse({
				schemaVersion: 1,
				executionId: "execution-failed",
				conversationId: "conversation-1",
				status: "failed",
				processSummary: [],
				startedAt: "2026-08-28T10:00:00Z",
				finishedAt: "2026-08-28T10:02:00Z",
				error: null,
			}).success,
		).toBe(false);
		expect(
			ExecutionDetailProjectionV1Schema.safeParse({
				schemaVersion: 1,
				executionId: "execution-completed",
				conversationId: "conversation-1",
				status: "completed",
				processSummary: [],
				startedAt: "2026-08-28T10:00:00Z",
				finishedAt: "2026-08-28T10:02:00Z",
				error: {
					schemaVersion: 1,
					code: "EXECUTION_FAILED",
					message: "Contradictory error",
					retryable: false,
					traceId: "trace-execution",
				},
			}).success,
		).toBe(false);
		expect(
			PlatformAuditProjectionV1Schema.parse({
				schemaVersion: 1,
				auditId: "audit-1",
				action: "agent.configuration.updated",
				actor: {
					userId: "user-1",
					displayName: "Ada",
					roles: ["employee"],
				},
				subjectType: "configuration",
				subjectId: "agent-1",
				result: "succeeded",
				summary: "Agent configuration updated",
				occurredAt: "2026-08-28T10:02:00Z",
				traceId: "trace-audit-1",
			}),
		).toMatchObject({ action: "agent.configuration.updated" });
	});
});
