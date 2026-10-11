import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import type { ApplicationCredentialResponse } from "./application-management.js";
import type { ApplicationManagementViewState } from "./application-management-screen.js";
import { ApplicationManagementScreen } from "./application-management-screen.js";

const metadata: ApplicationMetadataV1 = {
	applicationId: "application-1",
	authorizationRevision: "revision-1",
	createdAt: "2026-10-10T00:00:00Z",
	name: "Build service",
	responsibleUserId: "user-1",
	status: "active",
	updatedAt: "2026-10-10T00:00:00Z",
};

const response: ApplicationCredentialResponse = {
	metadata: {
		applicationId: metadata.applicationId,
		credentialId: "application-credential-1",
		createdAt: "2026-10-10T00:00:00Z",
		expiresAt: "2027-01-01T00:00:23.135Z",
		lastUsedAt: null,
		revokedAt: null,
		scopes: ["agent:read", "agent:use"],
	},
	delivery: {
		attemptId: "delivery-attempt-1",
		grantRevision: "material-grant-1",
		recipient: {
			principalType: "application",
			principalId: "recipient-service",
		},
		status: "accepted",
	},
	replayed: false,
};

function submitCredential() {
	fireEvent.change(screen.getByLabelText("接收主体 ID"), {
		target: { value: "recipient-1" },
	});
	fireEvent.click(screen.getByRole("button", { name: "签发应用凭证" }));
}

const changedScopes: {
	label: string;
	state: ApplicationManagementViewState;
}[] = [
	{
		label: "another application",
		state: {
			kind: "ready",
			application: { ...metadata, applicationId: "application-2" },
		},
	},
	{
		label: "new authorization revision",
		state: {
			kind: "ready",
			application: { ...metadata, authorizationRevision: "revision-2" },
		},
	},
	{
		label: "disabled application",
		state: { kind: "ready", application: { ...metadata, status: "disabled" } },
	},
	{ label: "read denial", state: { kind: "denied" } },
	{
		label: "missing application",
		state: { kind: "unavailable", reason: "not-found", retryable: false },
	},
	{
		label: "unavailable application",
		state: { kind: "unavailable", retryable: true },
	},
	{ label: "loading", state: { kind: "loading" } },
	{ label: "registration", state: { kind: "empty" } },
];

describe("ApplicationManagementScreen", () => {
	afterEach(cleanup);

	it("registers an application using the current-session owner", async () => {
		const onRegister = vi.fn().mockResolvedValue(metadata);
		render(
			<ApplicationManagementScreen
				state={{ kind: "empty" }}
				onRegister={onRegister}
			/>,
		);

		fireEvent.change(screen.getByLabelText("应用名称"), {
			target: { value: "  Build service  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "注册应用" }));
		await waitFor(() =>
			expect(onRegister).toHaveBeenCalledWith("Build service"),
		);
	});

	it("does not offer credential material when the application is disabled", () => {
		render(
			<ApplicationManagementScreen
				state={{
					kind: "ready",
					application: { ...metadata, status: "disabled" },
				}}
			/>,
		);

		expect(screen.getByText("应用已停用")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "签发应用凭证" })).toBeNull();
	});

	it("opens a trimmed existing ID without registering or assuming access", () => {
		const onOpenApplication = vi.fn();
		const onRegister = vi.fn();
		render(
			<ApplicationManagementScreen
				state={{ kind: "empty" }}
				onOpenApplication={onOpenApplication}
				onRegister={onRegister}
			/>,
		);
		const button = screen.getByRole("button", { name: "打开应用" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByLabelText("既有应用 ID"), {
			target: { value: "  application-1  " },
		});
		fireEvent.click(button);
		expect(onOpenApplication).toHaveBeenCalledWith("application-1");
		expect(onRegister).not.toHaveBeenCalled();
		expect(screen.queryByText("Build service")).toBeNull();
	});

	it.each(["not-found", "denied"] as const)(
		"shows %s without presenting registration as success",
		(reason) => {
			render(
				<ApplicationManagementScreen
					state={{ kind: "unavailable", reason, retryable: false }}
					onOpenApplication={vi.fn()}
					onRegister={vi.fn()}
				/>,
			);
			expect(screen.getByRole("alert").textContent).toContain(
				reason === "denied" ? "当前账号无权" : "找不到这个应用",
			);
			expect(screen.queryByRole("button", { name: "注册应用" })).toBeNull();
		},
	);

	it("retains safe response metadata and prepares an explicit rotation of its returned ID", async () => {
		const rotated: ApplicationCredentialResponse = {
			...response,
			metadata: { ...response.metadata, credentialId: "rotated-credential-2" },
			delivery: {
				...response.delivery,
				attemptId: "rotation-attempt-2",
				status: "delivery_pending",
			},
		};
		const onIssueCredential = vi
			.fn()
			.mockResolvedValueOnce({
				...response,
				credential: "synthetic-material-must-not-render",
			})
			.mockResolvedValueOnce(rotated);
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		submitCredential();
		await screen.findByText(response.metadata.credentialId);
		for (const value of [
			response.delivery.recipient.principalId,
			response.delivery.attemptId,
			response.delivery.grantRevision,
			"尚未使用",
			"未撤销",
			"读取 Agent、使用 Agent",
		])
			expect(screen.getByText(value)).toBeTruthy();
		expect(screen.queryByText("synthetic-material-must-not-render")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "使用此凭证 ID 轮换" }));
		expect(
			(screen.getByLabelText("要轮换的凭证 ID") as HTMLInputElement).value,
		).toBe(response.metadata.credentialId);
		expect(onIssueCredential).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "轮换应用凭证" }));
		await screen.findByText(rotated.metadata.credentialId);
		expect(onIssueCredential.mock.calls[1]?.[0]).toEqual({
			applicationId: metadata.applicationId,
			body: {
				operation: "rotate",
				credentialId: response.metadata.credentialId,
				recipient: response.delivery.recipient,
				scopes: response.metadata.scopes,
				expiresAt: response.metadata.expiresAt,
			},
		});
		expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
	});

	it.each([
		["delivery_pending", "等待投递"],
		["delivery_in_flight", "投递中"],
		["accepted", "投递通道已接收"],
		["failed", "投递失败"],
		["unknown", "投递结果未知"],
	] as const)(
		"shows actual %s status without retrying the operation",
		async (status, label) => {
			const onIssueCredential = vi.fn().mockResolvedValue({
				...response,
				replayed: true,
				delivery: { ...response.delivery, status },
			});
			render(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			submitCredential();
			await screen.findByText(label);
			expect(screen.getByRole("status").textContent).toContain(
				"原请求的回执，未再次签发",
			);
			if (status === "unknown")
				expect(screen.getByText(/无法确认材料是否已投递/)).toBeTruthy();
			expect(screen.queryByRole("button", { name: /重发|重试/ })).toBeNull();
			expect(onIssueCredential).toHaveBeenCalledTimes(1);
		},
	);

	it.each(changedScopes)(
		"clears a previous result for $label",
		async ({ state }) => {
			const onIssueCredential = vi.fn().mockResolvedValue(response);
			const view = render(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			submitCredential();
			await screen.findByText(response.metadata.credentialId);
			view.rerender(
				<ApplicationManagementScreen
					state={state}
					onIssueCredential={onIssueCredential}
				/>,
			);
			expect(
				screen.queryByRole("heading", { name: "应用凭证结果" }),
			).toBeNull();
			view.rerender(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
			expect(
				(screen.getByLabelText("接收主体 ID") as HTMLInputElement).value,
			).toBe("");
		},
	);

	it.each(changedScopes)(
		"ignores late success after $label",
		async ({ state }) => {
			let resolve: (value: ApplicationCredentialResponse) => void = () => {};
			const onIssueCredential = vi.fn(
				() =>
					new Promise<ApplicationCredentialResponse>((done) => {
						resolve = done;
					}),
			);
			const view = render(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			submitCredential();
			view.rerender(
				<ApplicationManagementScreen
					state={state}
					onIssueCredential={onIssueCredential}
				/>,
			);
			view.rerender(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			await act(async () => {
				resolve(response);
			});
			expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
			expect(
				screen.queryByRole("heading", { name: "应用凭证结果" }),
			).toBeNull();
		},
	);

	it("does not retain results through unmount or accept another application's receipt", async () => {
		let resolve: (value: ApplicationCredentialResponse) => void = () => {};
		const onIssueCredential = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ApplicationCredentialResponse>((done) => {
						resolve = done;
					}),
			)
			.mockResolvedValueOnce({
				...response,
				metadata: { ...response.metadata, applicationId: "wrong-application" },
			});
		const view = render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		submitCredential();
		view.unmount();
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		await act(async () => {
			resolve(response);
		});
		expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
		submitCredential();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "签发应用凭证",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
		expect(screen.queryByRole("heading", { name: "应用凭证结果" })).toBeNull();
	});

	it("clears the former result on rejected rotation and prevents duplicate submissions", async () => {
		const onIssueCredential = vi
			.fn()
			.mockResolvedValueOnce(response)
			.mockRejectedValueOnce(new Error("denied"));
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		submitCredential();
		fireEvent.click(screen.getByRole("button", { name: "正在提交…" }));
		await screen.findByText(response.metadata.credentialId);
		expect(onIssueCredential).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "使用此凭证 ID 轮换" }));
		fireEvent.click(screen.getByRole("button", { name: "轮换应用凭证" }));
		await waitFor(() => expect(onIssueCredential).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
	});
});
