import { AgentApplicationProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentApplicationForm } from "./agent-application-form.js";
import { pendingApplication } from "./test-fixtures.js";

afterEach(cleanup);

describe("AgentApplicationForm", () => {
	it("shows required model fields for a standard-template application", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Application name"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.change(screen.getByLabelText("Standard template ID"), {
			target: { value: "codex" },
		});
		expect(
			(screen.getByLabelText("Model option ID") as HTMLInputElement).required,
		).toBe(true);
		expect(
			(screen.getByLabelText("Credential value") as HTMLInputElement).required,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Create application" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not submit an initial standard application without a model credential", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Application name"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.change(screen.getByLabelText("Standard template ID"), {
			target: { value: "codex" },
		});
		fireEvent.change(screen.getByLabelText("Model option ID"), {
			target: { value: "model-primary" },
		});
		fireEvent.change(screen.getByLabelText("Model endpoint ID"), {
			target: { value: "endpoint-primary" },
		});
		fireEvent.change(screen.getByLabelText("Model ID"), {
			target: { value: "gpt-5" },
		});
		fireEvent.change(screen.getByLabelText("Reasoning levels"), {
			target: { value: "medium" },
		});
		fireEvent.change(screen.getByLabelText("Default model option ID"), {
			target: { value: "model-primary" },
		});
		fireEvent.change(screen.getByLabelText("Default reasoning level"), {
			target: { value: "medium" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create application" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("uses a rejected projection for explicit resubmission without replaying Secrets", () => {
		const onSubmit = vi.fn();
		const rejectedApplication = AgentApplicationProjectionV1Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: {
				decidedAt: "2026-09-04T00:00:00Z",
				reason: "Capacity is unavailable.",
			},
			configuration: {
				...pendingApplication.configuration,
				secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 2 }],
			},
		});
		render(
			<AgentApplicationForm
				action="resubmit"
				application={rejectedApplication}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Resubmitted after capacity review" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Resubmit application" }),
		);

		expect(onSubmit).toHaveBeenCalledWith({
			schemaVersion: 1,
			name: pendingApplication.name,
			description: "Resubmitted after capacity review",
			source: pendingApplication.source,
			coOwnerIds: ["user-applicant-1"],
			availability: [],
			actions: [],
			environment: [],
		});
		expect(screen.queryByDisplayValue("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("submits a custom self-managed source with its identity responsibility", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Application name"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.change(screen.getByLabelText("Source kind"), {
			target: { value: "custom-self-managed" },
		});
		fireEvent.change(screen.getByLabelText("Image reference"), {
			target: { value: "registry.example/agents/release:v1" },
		});
		fireEvent.change(screen.getByLabelText("Identity responsibility"), {
			target: { value: "self-managed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create application" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:v1",
					interactionMode: "self-managed",
					identityResponsibility: "self-managed",
				},
			}),
		);
	});

	it("submits the writable application configuration entered by the employee", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Application name"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.change(screen.getByLabelText("Standard template ID"), {
			target: { value: "codex" },
		});
		fireEvent.change(screen.getByLabelText("Co-owner IDs"), {
			target: { value: "owner-2\nowner-3" },
		});
		fireEvent.change(screen.getByLabelText("User availability IDs"), {
			target: { value: "user-available" },
		});
		fireEvent.change(screen.getByLabelText("Organization availability IDs"), {
			target: { value: "organization-available" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add action" }));
		fireEvent.change(screen.getByLabelText("Action provider ID"), {
			target: { value: "github" },
		});
		fireEvent.change(screen.getByLabelText("Action ID"), {
			target: { value: "issues.read" },
		});
		fireEvent.change(screen.getByLabelText("Action version"), {
			target: { value: "v3" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add environment value" }),
		);
		fireEvent.change(screen.getByLabelText("Environment name"), {
			target: { value: "LOG_LEVEL" },
		});
		fireEvent.change(screen.getByLabelText("Environment value"), {
			target: { value: "debug" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
		fireEvent.change(screen.getByLabelText("Secret name"), {
			target: { value: "MODEL_API_KEY" },
		});
		fireEvent.change(screen.getByLabelText("Secret value"), {
			target: { value: "never-echo" },
		});
		fireEvent.change(screen.getByLabelText("Model option ID"), {
			target: { value: "model-primary" },
		});
		fireEvent.change(screen.getByLabelText("Model endpoint ID"), {
			target: { value: "endpoint-primary" },
		});
		fireEvent.change(screen.getByLabelText("Model ID"), {
			target: { value: "gpt-5" },
		});
		fireEvent.change(screen.getByLabelText("Reasoning levels"), {
			target: { value: "medium\nhigh" },
		});
		fireEvent.change(screen.getByLabelText("Credential value"), {
			target: { value: "never-echo-model" },
		});
		fireEvent.change(screen.getByLabelText("Default model option ID"), {
			target: { value: "model-primary" },
		});
		fireEvent.change(screen.getByLabelText("Default reasoning level"), {
			target: { value: "medium" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create application" }));

		expect(onSubmit).toHaveBeenCalledWith({
			schemaVersion: 1,
			name: "Release assistant",
			description: "Helps the release team",
			source: { kind: "standard", templateId: "codex" },
			coOwnerIds: ["owner-2", "owner-3"],
			availability: [
				{ kind: "user", userId: "user-available" },
				{ kind: "organization", organizationId: "organization-available" },
			],
			actions: [
				{
					providerId: "github",
					actionId: "issues.read",
					actionVersion: "v3",
				},
			],
			environment: [{ name: "LOG_LEVEL", value: "debug" }],
			secrets: [{ name: "MODEL_API_KEY", value: "never-echo" }],
			modelConfiguration: {
				options: [
					{
						optionId: "model-primary",
						endpointId: "endpoint-primary",
						modelId: "gpt-5",
						reasoningLevels: ["medium", "high"],
						credentialValue: "never-echo-model",
					},
				],
				defaultOptionId: "model-primary",
				defaultReasoningLevel: "medium",
			},
		});
	});

	it("does not submit a partially completed configuration row", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Application name"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.change(screen.getByLabelText("Standard template ID"), {
			target: { value: "codex" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add action" }));
		fireEvent.change(screen.getByLabelText("Action provider ID"), {
			target: { value: "github" },
		});
		expect(
			(screen.getByLabelText("Action ID") as HTMLInputElement).required,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Create application" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("uses a new server projection when an edit form changes application", () => {
		const first = AgentApplicationProjectionV1Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: {
				decidedAt: "2026-09-04T00:00:00Z",
				reason: "Capacity is unavailable.",
			},
		});
		const second = AgentApplicationProjectionV1Schema.parse({
			...first,
			applicationId: "application-other",
			name: "Other release assistant",
		});
		const { rerender } = render(
			<AgentApplicationForm
				action="resubmit"
				application={first}
				key={first.applicationId}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(
			(screen.getByLabelText("Application name") as HTMLInputElement).value,
		).toBe("Release assistant request");

		rerender(
			<AgentApplicationForm
				action="resubmit"
				application={second}
				key={second.applicationId}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(
			(screen.getByLabelText("Application name") as HTMLInputElement).value,
		).toBe("Other release assistant");
	});
});
