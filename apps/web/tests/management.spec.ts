import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV1,
	pilotFakeScenariosV1,
} from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

import { pendingApplication } from "../src/features/my-agents/test-fixtures";
import type {
	AgentApplicationCreateRequestV1Writable,
	AgentLifecycleCommandRequestV1,
	ApprovalDecisionRequestV1,
} from "../src/pilot/generated/types.gen";

async function fixture(
	page: Page,
	role: "owner" | "admin" | "employee" = "owner",
) {
	let application = AgentApplicationProjectionV1Schema.parse({
		...pendingApplication,
		applicationId: "application-browser-1",
	});
	let agent = AgentProjectionV1Schema.parse(
		pilotFakeScenariosV1.starting.response.body,
	);
	const session = {
		schemaVersion: 1,
		user: {
			userId: role === "owner" ? "user-owner-1" : `user-${role}`,
			displayName: role,
			roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
		},
	};
	const server = createPilotAgentMockServerV1({
		getCurrentSession: { status: 200, body: session },
		listAgents: () => ({
			status: 200,
			body: { items: [agent], nextCursor: null },
		}),
		getAgent: () => ({ status: 200, body: agent }),
		listAgentApplications: () => ({
			status: 200,
			body: { items: [application], nextCursor: null },
		}),
		getAgentApplication: () => ({ status: 200, body: application }),
		createAgentApplication: () => ({ status: 201, body: application }),
		updateAgentApplication: () => ({ status: 200, body: application }),
		withdrawAgentApplication: () => ({ status: 200, body: application }),
		listPendingAgentApplications: () => ({
			status: 200,
			body: {
				items: application.status === "pending_approval" ? [application] : [],
				nextCursor: null,
			},
		}),
		decideAgentApplication: () => ({ status: 200, body: application }),
		updateAgentConfiguration: () => ({ status: 200, body: agent }),
		commandAgentLifecycle: () => ({ status: 202, body: agent }),
	});
	let release: (() => void) | undefined;
	let nextGate: Promise<void> | undefined;
	let rejectNextWithdrawal = false;
	const commands: { path: string; body: unknown; key: string | undefined }[] =
		[];
	await page.route("**/api/v1/**", async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		const body = request.postData() ? request.postDataJSON() : undefined;
		if (request.method() !== "GET") {
			commands.push({
				path: pathname,
				body,
				key: request.headers()["idempotency-key"],
			});
			await nextGate;
			nextGate = undefined;
			if (pathname.endsWith("/withdraw") && rejectNextWithdrawal) {
				rejectNextWithdrawal = false;
				await route.fulfill({
					status: 409,
					json: {
						schemaVersion: 1,
						code: "RESOURCE_UNAVAILABLE",
						message: "Application state changed",
						retryable: false,
						traceId: "trace-withdraw-conflict",
					},
				});
				return;
			}
			if (pathname.endsWith("/decision")) {
				const decision = body as ApprovalDecisionRequestV1;
				application = AgentApplicationProjectionV1Schema.parse({
					...application,
					status: decision.decision === "approve" ? "creating" : "rejected",
					decision: {
						decidedAt: "2026-09-07T00:00:00Z",
						reason: "reason" in decision ? decision.reason : null,
					},
				});
			} else if (pathname.endsWith("/withdraw")) {
				application = { ...application, status: "withdrawn" };
			} else if (pathname.includes("/agent-applications")) {
				const draft = body as AgentApplicationCreateRequestV1Writable;
				application = {
					...application,
					name: draft.name,
					description: draft.description,
					source: draft.source,
					status: "pending_approval",
				};
			} else if (pathname.endsWith("/lifecycle")) {
				const command = body as AgentLifecycleCommandRequestV1;
				agent = {
					...agent,
					managementStatus:
						command.command === "stop"
							? "stopped"
							: command.command === "disable"
								? "disabled"
								: "available",
					serviceAvailability:
						command.command === "stop" || command.command === "disable"
							? null
							: "starting",
				};
			}
		}
		const response = await server.fetch(
			new Request(request.url(), {
				method: request.method(),
				headers: request.headers(),
				body: request.postData(),
			}),
		);
		await route.fulfill({
			status: response.status,
			contentType: "application/json",
			body: await response.text(),
		});
	});
	return {
		commands,
		holdNextCommand() {
			nextGate = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release() {
			release?.();
		},
		rejectApplication() {
			application = {
				...application,
				status: "rejected",
				decision: {
					decidedAt: "2026-09-07T00:00:00Z",
					reason: "Capacity is unavailable",
				},
			};
		},
		rejectNextWithdrawal() {
			rejectNextWithdrawal = true;
		},
		customAgent() {
			agent = {
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agent:v1",
					interactionMode: "platform-adapter",
				},
			};
		},
	};
}

async function capture(page: Page, info: TestInfo, name: string) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	const overflow = await page
		.locator(
			"main button, main input:not([type=hidden]):not([aria-hidden=true]), main textarea, main select, main label, main [role=checkbox]",
		)
		.evaluateAll((elements) =>
			elements
				.filter((element) => {
					const box = element.getBoundingClientRect();
					return (
						box.width > 0 &&
						(box.left < 0 ||
							box.right > window.innerWidth + 1 ||
							(element.tagName === "BUTTON" &&
								element.scrollWidth > element.clientWidth + 1))
					);
				})
				.map((element) => element.tagName),
		);
	expect(overflow).toEqual([]);
	const path = info.outputPath(`${name}-${info.project.name}.png`);
	await page.screenshot({ path, fullPage: true });
	await info.attach(`${name} (${info.config.metadata.head})`, {
		path,
		contentType: "image/png",
	});
}

test("create, edit, resubmit and withdraw with native form and pending semantics", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const create = page.getByRole("button", {
		name: "Create application",
		exact: true,
	});
	await create.click();
	await expect(page.getByLabel("Application name")).toBeFocused();
	expect(api.commands).toHaveLength(0);
	await page.getByLabel("Application name").fill("Release assistant");
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Description", { exact: true })).toBeFocused();
	expect(
		await page
			.getByLabel("Description", { exact: true })
			.evaluate((element) => getComputedStyle(element).boxShadow),
	).not.toBe("none");
	await page
		.getByLabel("Description", { exact: true })
		.fill("Helps the release team");
	await page.getByLabel("Source kind").focus();
	await page.getByLabel("Source kind").selectOption("custom-platform-adapter");
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Image reference")).toBeFocused();
	await expect(page.getByLabel("Source kind")).toHaveValue(
		"custom-platform-adapter",
	);
	await page
		.getByLabel("Image reference")
		.fill("registry.example/agents/release:v1");
	await capture(page, info, "create-application");
	api.holdNextCommand();
	await create.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("button", { name: "Submitting..." }),
	).toBeDisabled();
	await expect(page.getByLabel("Application name")).toBeDisabled();
	await page.keyboard.press("Enter");
	await expect.poll(() => api.commands.length).toBe(1);
	expect(api.commands[0]?.body).toEqual({
		schemaVersion: 1,
		name: "Release assistant",
		description: "Helps the release team",
		source: {
			kind: "custom",
			imageReference: "registry.example/agents/release:v1",
			interactionMode: "platform-adapter",
		},
		coOwnerIds: [],
		availability: [],
		actions: [],
		environment: [],
		secrets: [],
	});
	expect(api.commands[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
	await capture(page, info, "application-pending");
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await page.getByRole("link", { name: "Open application" }).click();
	await page.getByRole("link", { name: "Edit application" }).click();
	await expect(page.getByLabel("Source kind")).toBeDisabled();
	await page
		.getByLabel("Description", { exact: true })
		.fill("Updated release workflow");
	await page
		.getByRole("button", { name: "Edit application", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("Application submitted");
	api.rejectApplication();
	await page.goto("/my-agents/application-browser-1/edit");
	await page
		.getByRole("button", { name: "Resubmit application", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("Pending approval");
	await page.getByRole("link", { name: "Open application" }).click();
	const withdraw = page.getByRole("button", { name: "Withdraw application" });
	api.rejectNextWithdrawal();
	await withdraw.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("alert")).toHaveText(
		"Unable to withdraw application.",
	);
	await expect(withdraw).toBeEnabled();
	await expect(withdraw).toBeFocused();
	await capture(page, info, "withdraw-application-error");
	api.holdNextCommand();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("button", { name: "Withdrawing..." }),
	).toBeDisabled();
	api.release();
	await expect(page.getByText("Withdrawn", { exact: true })).toBeVisible();
	await expect(page.getByRole("status")).toBeFocused();
	await expect(page.getByRole("status")).toHaveText(
		"Withdrawal submitted: Withdrawn.",
	);
	await expect(
		page.getByRole("button", { name: "Withdraw application" }),
	).toHaveCount(0);
});

test("administrator rejection, approval, empty queue and pending controls", async ({
	page,
}, info) => {
	const api = await fixture(page, "admin");
	await page.goto("/admin/approvals");
	const reject = page.getByRole("button", { name: "Reject application" });
	await expect(reject).toBeDisabled();
	await page.getByLabel("Rejection reason").fill("  Capacity is unavailable  ");
	await page.getByLabel("Rejection reason").focus();
	await page.keyboard.press("Tab");
	await expect(reject).toBeFocused();
	await capture(page, info, "approvals");
	api.holdNextCommand();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("button", { name: "Rejecting..." }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Approve application" }),
	).toBeDisabled();
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await expect(page.getByText("No pending Agent applications.")).toBeVisible();
	expect(api.commands[0]?.body).toEqual({
		schemaVersion: 1,
		decision: "reject",
		reason: "Capacity is unavailable",
	});
	await capture(page, info, "approvals-empty");
	await page.goto("/my-agents/application-browser-1/edit");
	await page
		.getByRole("button", { name: "Resubmit application", exact: true })
		.click();
	await expect(page.getByRole("status")).toBeVisible();
	await page.goto("/admin/approvals");
	await page.getByRole("button", { name: "Approve application" }).click();
	await expect(page.getByRole("status")).toContainText("Creating");
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 1,
		decision: "approve",
	});
});

test("Owner configuration checkbox, Secret clearing, lifecycle and custom image upgrade", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents/agent-pilot-1");
	await page.getByRole("link", { name: "Owner settings" }).click();
	const replaceModels = page.getByRole("checkbox", {
		name: "Replace model configuration",
	});
	await replaceModels.focus();
	await page.keyboard.press("Space");
	await expect(replaceModels).toBeChecked();
	await expect(page.getByLabel("Credential value")).toHaveValue("");
	await page.keyboard.press("Space");
	await expect(replaceModels).not.toBeChecked();
	await page.getByRole("button", { name: "Add Secret" }).click();
	await page.getByLabel("Secret name").fill("RELEASE_KEY");
	await page.getByLabel("Secret value").fill("synthetic-browser-secret");
	await expect(page.getByLabel("Secret value")).toHaveAttribute(
		"type",
		"password",
	);
	await capture(page, info, "owner-configuration");
	api.holdNextCommand();
	await page.getByRole("button", { name: "Save configuration" }).click();
	await expect(
		page.getByRole("button", { name: "Saving configuration..." }),
	).toBeDisabled();
	await expect(replaceModels).toBeDisabled();
	await expect(page.getByLabel("Secret value")).toHaveCount(0);
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await expect(page.locator("body")).not.toContainText(
		"synthetic-browser-secret",
	);
	expect(api.commands[0]?.body).toMatchObject({
		schemaVersion: 1,
		coOwnerIds: ["user-owner-1"],
		secrets: [{ name: "RELEASE_KEY", value: "synthetic-browser-secret" }],
	});
	await page.goto("/agents/agent-pilot-1");
	await capture(page, info, "lifecycle");
	api.holdNextCommand();
	await page.getByRole("button", { name: "Stop Agent" }).focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("button", { name: "Stopping..." }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Restart Agent" }),
	).toBeDisabled();
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await page.getByRole("button", { name: "Restart Agent" }).click();
	await expect(page.getByRole("status")).toContainText("Available");
	api.customAgent();
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("button", { name: "Upgrade image" }),
	).toBeDisabled();
	await page
		.getByLabel("New image reference")
		.fill("registry.example/agent:v2");
	api.holdNextCommand();
	await page.getByRole("button", { name: "Upgrade image" }).click();
	await expect(
		page.getByRole("button", { name: "Upgrading image..." }),
	).toBeDisabled();
	await expect(page.getByLabel("New image reference")).toBeDisabled();
	api.release();
	await expect(page.getByRole("status")).toContainText(
		"Configuration submitted",
	);
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 1,
		command: "upgrade_custom_image",
		imageReference: "registry.example/agent:v2",
	});
});

test("employee has no Owner or administrator controls, with loading and error states", async ({
	page,
}, info) => {
	await fixture(page, "employee");
	await page.goto("/agents/agent-pilot-1");
	await expect(
		page.getByRole("heading", { name: "Release assistant", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "Owner settings" })).toHaveCount(
		0,
	);
	await expect(page.getByRole("button")).toHaveCount(0);
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("alert")).toHaveText(
		"This configuration is unavailable.",
	);
	await page.goto("/admin/approvals");
	await expect(page.getByRole("alert")).toHaveText(
		"Approvals are unavailable.",
	);
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/v1/agents", async (route) => {
		await gate;
		await route.fulfill({
			status: 403,
			json: pilotFakeScenariosV1.unauthorized.response.body,
		});
	});
	await page.goto("/agents");
	await expect(page.getByText("Loading Agents...")).toBeVisible();
	await capture(page, info, "agents-loading");
	release?.();
	await expect(page.getByRole("alert")).toHaveText(
		"Please contact an administrator.",
	);
	await capture(page, info, "agents-unavailable");
});
