// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen";
import { PersonalRuntimeSection } from "./personal-runtime-section";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it("saves the selected stable references and shows the original offline binding on re-entry", async () => {
	const agentId = "agent-a";
	const userId = "employee";
	const services = ["first", "second"];
	let revision = 0;
	let saved: {
		serviceId: string;
		deviceRef: string;
		runtimeRef: string;
		deviceName: string;
		runtimeName: string;
	} | null = null;
	let online = true;
	client.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			if (path === "/api/v2/me/external-runtime-targets") {
				const { id } = await input.json();
				return Response.json({
					revision: 1,
					directory: {
						schemaVersion: 1,
						instanceId: id,
						subjectId: userId,
						devices: ["d1", "d2"].map((ref) => ({
							ref,
							displayName: "Mac",
							status: online ? "online" : "offline",
							runtimes: [
								{
									ref: "codex",
									displayName: "Codex",
									status: online ? "available" : "unavailable",
									capabilities: ["execute"],
								},
							],
						})),
					},
				});
			}
			expect(path).toBe("/api/v2/agents/agent-a/personal-runtime");
			if (input.method === "PUT") {
				const body = await input.json();
				expect(body).toEqual({
					expectedRevision: 0,
					target: { serviceId: "second", deviceRef: "d2", runtimeRef: "codex" },
				});
				saved = { ...body.target, deviceName: "Mac", runtimeName: "Codex" };
				revision++;
			}
			return Response.json({ revision, target: saved, services });
		}),
	);
	const open = () =>
		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<PersonalRuntimeSection agentId={agentId} userId={userId} />
			</QueryClientProvider>,
		);
	const first = open();
	fireEvent.change(await screen.findByLabelText("执行服务"), {
		target: { value: "second" },
	});
	await screen.findByRole("option", { name: /Mac（d2）/ });
	fireEvent.change(screen.getByLabelText("我的设备"), {
		target: { value: "d2" },
	});
	fireEvent.change(screen.getByLabelText("设备上的 Runtime"), {
		target: { value: "codex" },
	});
	fireEvent.click(screen.getByRole("button", { name: "保存个人 Runtime" }));
	await waitFor(() =>
		expect(screen.getByText(/已绑定 second · Mac（d2）/)).toBeTruthy(),
	);
	first.unmount();
	online = false;
	open();
	await waitFor(() =>
		expect(
			screen.getByText(/已绑定 second · Mac（d2）.*离线 · 不可用/),
		).toBeTruthy(),
	);
	expect((screen.getByLabelText("我的设备") as HTMLSelectElement).value).toBe(
		"d2",
	);
	expect(
		(screen.getByLabelText("设备上的 Runtime") as HTMLSelectElement).value,
	).toBe("codex");
});
