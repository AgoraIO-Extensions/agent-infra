import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated/client.gen.js";
import { WecomAppSetup } from "./wecom-app-setup.js";

afterEach(() => vi.unstubAllGlobals());

it("submits the application setup contract and clears write-only fields", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const bodies: unknown[] = [];
	let reads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			if (path.endsWith("/wecom-app"))
				return Response.json({ status: "not_configured" });
			if (path.endsWith("/wecom-app-setup"))
				return Response.json({
					sessionId: "setup",
					state: "state",
					callbackUrl: "https://callback.test",
					status: "awaiting_input",
				});
			if (path.endsWith("/credentials")) {
				bodies.push(await input.json());
				return Response.json({ sessionId: "setup", status: "verifying" });
			}
			reads++;
			return Response.json({ sessionId: "setup", status: "active" });
		}),
	);
	render(<WecomAppSetup agentId="agent" onUnbind={vi.fn()} />);
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	for (const [label, value] of [
		["企业 ID", "corp"],
		["应用 ID", "123"],
		["应用 Secret", "secret"],
		["回调 Token", "token"],
		["EncodingAESKey", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"],
	] as const)
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
	expect((screen.getByLabelText("应用 Secret") as HTMLInputElement).value).toBe(
		"",
	);
	expect((screen.getByLabelText("回调 Token") as HTMLInputElement).value).toBe(
		"",
	);
	expect(
		(screen.getByLabelText("EncodingAESKey") as HTMLInputElement).value,
	).toBe("");
	await waitFor(() => expect(bodies).toHaveLength(1));
	expect(bodies[0]).toMatchObject({
		corporationId: "corp",
		applicationId: "123",
		secret: "secret",
		token: "token",
		takeoverConfirmed: true,
		state: "state",
	});
	expect(reads).toBeGreaterThan(0);
});
