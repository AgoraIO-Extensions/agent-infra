import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { ConfigurationConnectionSection } from "./configuration-connection-section.js";
import {
	associateAgentConnection,
	ConnectionAssociationRequestError,
	disconnectAgentConnection,
	loadAgentConnectionAssociation,
} from "./connection-association.js";

vi.mock("./connection-association.js", async (original) => ({
	...(await original<typeof import("./connection-association.js")>()),
	loadAgentConnectionAssociation: vi.fn(),
	associateAgentConnection: vi.fn(),
	disconnectAgentConnection: vi.fn(),
	enableAgentConnectionRegistration: vi.fn(),
}));

const credential = "SYNTHETIC_CONNECTION_SERVICE_CREDENTIAL";
const notEnabled = {
	schemaVersion: 1 as const,
	status: "not_enabled" as const,
	source: null,
	associationRevision: null,
	automaticRegistrationAvailable: false,
};
const associated = {
	...notEnabled,
	status: "associated" as const,
	source: "manual" as const,
	associationRevision: 1,
};

function renderSection() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<ConfigurationConnectionSection
					agentId="agent-1"
					consoleUrl="https://connection.example.test/connection/connections"
					disabled={false}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	return client;
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	globalThis.localStorage?.clear();
	globalThis.sessionStorage?.clear();
});

describe("Agent settings Connection section", () => {
	it("shows not enabled, a console link and associates with a write-only credential", async () => {
		vi.mocked(loadAgentConnectionAssociation).mockResolvedValue(notEnabled);
		vi.mocked(associateAgentConnection).mockResolvedValue(associated);
		const client = renderSection();
		expect(
			(await screen.findByTestId("connection-association-status")).textContent,
		).toContain("未启用");
		expect(
			screen
				.getByRole("link", { name: /打开 Connection 控制台/ })
				.getAttribute("href"),
		).toBe("https://connection.example.test/connection/connections");
		fireEvent.click(screen.getByRole("button", { name: "手工关联" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("按使用者身份执行");
		const secret = within(dialog).getByLabelText("服务凭据");
		expect(secret.getAttribute("type")).toBe("password");
		fireEvent.change(within(dialog).getByLabelText("Connection Agent ID"), {
			target: { value: "connection-agent-1" },
		});
		fireEvent.change(secret, { target: { value: credential } });
		fireEvent.click(within(dialog).getByRole("button", { name: "核实并关联" }));
		await waitFor(() =>
			expect(associateAgentConnection).toHaveBeenCalledWith("agent-1", {
				connectionAgentId: "connection-agent-1",
				serviceCredential: credential,
				expectedRevision: null,
			}),
		);
		expect(
			(await screen.findByTestId("connection-association-status")).textContent,
		).toContain("已关联");
		// The credential is not kept in the query cache, the DOM or browser storage.
		expect(
			JSON.stringify(
				client
					.getQueryCache()
					.getAll()
					.map((q) => q.state),
			),
		).not.toContain(credential);
		expect(document.body.innerHTML).not.toContain(credential);
		for (const storage of [globalThis.localStorage, globalThis.sessionStorage])
			if (storage)
				for (let index = 0; index < storage.length; index++)
					expect(storage.getItem(storage.key(index) ?? "")).not.toContain(
						credential,
					);
	});

	it("keeps the dialog open with a stable reason when Connection rejects the credential", async () => {
		vi.mocked(loadAgentConnectionAssociation).mockResolvedValue(notEnabled);
		vi.mocked(associateAgentConnection).mockRejectedValue(
			new ConnectionAssociationRequestError("credential_rejected"),
		);
		renderSection();
		fireEvent.click(await screen.findByRole("button", { name: "手工关联" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByLabelText("Connection Agent ID"), {
			target: { value: "connection-agent-1" },
		});
		fireEvent.change(within(dialog).getByLabelText("服务凭据"), {
			target: { value: credential },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "核实并关联" }));
		expect((await within(dialog).findByRole("alert")).textContent).toContain(
			"Connection 未接受这个服务凭据",
		);
		expect(
			screen.getByTestId("connection-association-status").textContent,
		).toContain("未启用");
	});

	it("replaces with the current revision and disconnects after confirmation", async () => {
		vi.mocked(loadAgentConnectionAssociation).mockResolvedValue(associated);
		vi.mocked(associateAgentConnection).mockResolvedValue({
			...associated,
			associationRevision: 2,
		});
		vi.mocked(disconnectAgentConnection).mockResolvedValue(notEnabled);
		renderSection();
		fireEvent.click(
			await screen.findByRole("button", { name: "替换服务凭据" }),
		);
		const dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByLabelText("Connection Agent ID"), {
			target: { value: "connection-agent-1" },
		});
		fireEvent.change(within(dialog).getByLabelText("服务凭据"), {
			target: { value: credential },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "核实并替换" }));
		await waitFor(() =>
			expect(associateAgentConnection).toHaveBeenCalledWith(
				"agent-1",
				expect.objectContaining({ expectedRevision: 1 }),
			),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "解除关联" }));
		fireEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "解除关联",
			}),
		);
		await waitFor(() =>
			expect(disconnectAgentConnection).toHaveBeenCalledWith("agent-1", 2),
		);
		expect(
			await screen.findByRole("button", { name: "手工关联" }),
		).toBeTruthy();
	});
	it("keeps an automatic recovery candidate unverified and submits the current revision without retaining the secret", async () => {
		const pending = {
			...notEnabled,
			source: "automatic" as const,
			status: "unverified" as const,
			automaticRegistrationAvailable: true,
			credentialRecoveryAvailable: true as const,
			associationRevision: 2,
		};
		vi.mocked(loadAgentConnectionAssociation).mockResolvedValue(pending);
		vi.mocked(associateAgentConnection).mockResolvedValue({
			...pending,
			associationRevision: 3,
		});
		const client = renderSection();
		fireEvent.click(
			await screen.findByRole("button", { name: "补交原 Agent 服务凭据" }),
		);
		const dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByLabelText("Connection Agent ID"), {
			target: { value: "original-agent" },
		});
		fireEvent.change(within(dialog).getByLabelText("服务凭据"), {
			target: { value: credential },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "核实并关联" }));
		await waitFor(() =>
			expect(associateAgentConnection).toHaveBeenCalledWith("agent-1", {
				connectionAgentId: "original-agent",
				serviceCredential: credential,
				expectedRevision: 2,
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			screen.getByTestId("connection-association-status").textContent,
		).toContain("待核实");
		expect(screen.queryByRole("button", { name: "解除关联" })).toBeNull();
		expect(
			JSON.stringify(
				client
					.getQueryCache()
					.getAll()
					.map((q) => q.state),
			),
		).not.toContain(credential);
		expect(document.body.innerHTML).not.toContain(credential);
	});
	it("does not offer recovery for the unchanged v1 automatic route", async () => {
		vi.mocked(loadAgentConnectionAssociation).mockResolvedValue({
			...notEnabled,
			source: "automatic",
			status: "unverified",
			automaticRegistrationAvailable: true,
		});
		renderSection();
		await screen.findByTestId("connection-association-status");
		expect(
			screen.queryByRole("button", { name: "补交原 Agent 服务凭据" }),
		).toBeNull();
	});
});
