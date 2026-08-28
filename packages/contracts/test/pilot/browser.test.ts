import { describe, expect, it } from "vitest";
import { createDocument } from "zod-openapi";

import {
	AgentApplicationCreateRequestV1Schema,
	AgentApplicationProjectionV1Schema,
	AgentConfigurationProjectionV1Schema,
	AgentConfigurationUpdateRequestV1Schema,
	AgentLifecycleCommandRequestV1Schema,
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
				createdAt: "2026-08-28T10:02:00Z",
			}),
		).toMatchObject({ answerVersion: 2, isCurrentAnswer: true });
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
