// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	login: vi.fn(async () => ({
		account: { displayName: "连接用户", email: "user@example.invalid" },
		isAdministrator: false,
	})),
	navigate: vi.fn(async () => undefined),
	returnTo: "/connection/connections?provider=confluence&intent=authorize",
}));

vi.mock("../api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api")>();
	return {
		...actual,
		connectionApi: { ...actual.connectionApi, login: mocks.login },
	};
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => mocks.navigate,
}));

import { ConnectionApiError } from "../api";
import { LoginPage } from "../pages/login-page";

afterEach(() => {
	cleanup();
	mocks.returnTo =
		"/connection/connections?provider=confluence&intent=authorize";
	vi.clearAllMocks();
});

function renderLogin(client = new QueryClient()) {
	return render(
		<QueryClientProvider client={client}>
			<LoginPage returnTo={mocks.returnTo} />
		</QueryClientProvider>,
	);
}

async function login() {
	fireEvent.change(screen.getByLabelText("公司账号"), {
		target: { value: "connection-user" },
	});
	fireEvent.change(screen.getByLabelText("密码"), {
		target: { value: "password" },
	});
	fireEvent.submit(screen.getByRole("button", { name: "登录" }));
	await waitFor(() => expect(mocks.login).toHaveBeenCalledOnce());
}

describe("Connection 登录恢复", () => {
	it("登录成功后清除上一账号的业务缓存", async () => {
		const client = new QueryClient();
		client.setQueryData(["connections"], { owner: "previous-account" });
		client.setQueryData(["session"], {
			account: { displayName: "previous-account" },
		});
		renderLogin(client);
		await login();
		await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
		expect(client.getQueryData(["connections"])).toBeUndefined();
		expect(client.getQueryData(["session"])).toMatchObject({
			account: { displayName: "连接用户" },
		});
	});
	it("公司入口过期时只展示恢复链接，不自动重放密码", async () => {
		mocks.login.mockRejectedValueOnce(
			new ConnectionApiError({
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.company_oauth_required",
				retryable: false,
				traceId: "test",
			}),
		);
		renderLogin();
		await login();
		const link = await screen.findByRole("link", { name: "公司 OAuth 登录" });
		expect(link.getAttribute("href")).toContain(
			"/api/v1/connection/identity/oauth/entry?returnTo=",
		);
		expect(screen.queryByLabelText("密码")).toBeNull();
		expect(mocks.login).toHaveBeenCalledTimes(1);
		expect(mocks.navigate).not.toHaveBeenCalled();
	});
	it("登录后恢复受控的 Provider 授权深链", async () => {
		renderLogin();
		await login();

		expect(mocks.navigate).toHaveBeenCalledWith({
			search: { intent: "authorize", provider: "confluence" },
			to: "/connection/connections",
		});
	});

	it("拒绝外部 returnTo", async () => {
		mocks.returnTo = "https://evil.example/steal";
		renderLogin();
		await login();

		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/connection/connections",
		});
	});
});
