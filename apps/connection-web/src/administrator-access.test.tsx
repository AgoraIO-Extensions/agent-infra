// @vitest-environment jsdom
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), mount: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({
	...(await importOriginal<typeof import("./api")>()),
	connectionApi: { getSession: mocks.getSession },
}));
vi.mock("@tanstack/react-router", () => ({
	Navigate: ({ to }: { to: string }) => <div>跳转 {to}</div>,
}));

import { AdministratorAccess } from "./administrator-access";
import { ConnectionApiError } from "./api";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
function Content() {
	mocks.mount();
	return <div>注册 Agent</div>;
}
function show(
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	content = <Content />,
) {
	render(
		<QueryClientProvider client={client}>
			<AdministratorAccess>{content}</AdministratorAccess>
		</QueryClientProvider>,
	);
}
it("普通用户不会挂载管理页面或发出其数据请求", async () => {
	mocks.getSession.mockResolvedValue({ isAdministrator: false });
	show();
	await screen.findByText("跳转 /connection/connections");
	expect(mocks.mount).not.toHaveBeenCalled();
	expect(screen.queryByText("注册 Agent")).toBeNull();
});
it("权限确认前不挂载管理页面，管理员确认后可访问", async () => {
	mocks.getSession.mockResolvedValue({ isAdministrator: true });
	show();
	expect(mocks.mount).not.toHaveBeenCalled();
	await screen.findByText("注册 Agent");
});
it("失效会话返回登录页，不挂载管理页面", async () => {
	mocks.getSession.mockRejectedValue(authenticationRequired());
	show();
	await screen.findByText("跳转 /connection/login");
	expect(mocks.mount).not.toHaveBeenCalled();
});

function authenticationRequired() {
	return new ConnectionApiError({
		code: "AUTHENTICATION_REQUIRED",
		messageKey: "connection.error.authentication_required",
		retryable: false,
		traceId: "test",
	});
}
it.each([
	new Error("network failure"),
	new ConnectionApiError({
		code: "SERVER_ERROR",
		messageKey: "connection.error.server_error",
		retryable: true,
		traceId: "test",
	}),
])("服务或网络故障显示重试，不跳转或挂载管理页面", async (error) => {
	mocks.getSession
		.mockRejectedValueOnce(error)
		.mockResolvedValue({ isAdministrator: true });
	show();
	await screen.findByRole("alert");
	expect(screen.queryByText("跳转 /connection/login")).toBeNull();
	expect(mocks.mount).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "重试" }));
	await screen.findByText("注册 Agent");
});
it.each(["普通用户", "失效会话", "服务故障"])(
	"旧管理员缓存不能在重新确认前放行：%s",
	async (result) => {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});
		client.setQueryData(["session"], { isAdministrator: true });
		let resolve!: (value: { isAdministrator: boolean }) => void;
		let reject!: (reason: unknown) => void;
		mocks.getSession.mockImplementationOnce(
			() =>
				new Promise((yes, no) => {
					resolve = yes;
					reject = no;
				}),
		);
		show(client);
		expect(screen.getByRole("status")).toBeTruthy();
		await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
		expect(mocks.mount).not.toHaveBeenCalled();
		if (result === "普通用户") resolve({ isAdministrator: false });
		else
			reject(
				result === "失效会话"
					? authenticationRequired()
					: new Error("network failure"),
			);
		if (result === "普通用户")
			await screen.findByText("跳转 /connection/connections");
		else if (result === "失效会话")
			await screen.findByText("跳转 /connection/login");
		else await screen.findByRole("alert");
		expect(mocks.mount).not.toHaveBeenCalled();
	},
);

it("子页面共享 Session 查询时不会因再次刷新而反复卸载", async () => {
	mocks.getSession.mockResolvedValue({ isAdministrator: true });
	function SessionConsumer() {
		useQuery({ queryKey: ["session"], queryFn: mocks.getSession });
		return <div>管理内容</div>;
	}
	show(undefined, <SessionConsumer />);
	await screen.findByText("管理内容");
	await waitFor(() => expect(mocks.getSession).toHaveBeenCalledTimes(2));
	expect(screen.queryByRole("status")).toBeNull();
});
