import { SkillHubVersionMetadataV1Schema } from "@agent-infra/contracts/pilot";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
	SkillHubDirectoryScreen,
	SkillHubVersionScreen,
} from "./skill-hub-screen.js";

const version = SkillHubVersionMetadataV1Schema.parse({
	schemaVersion: 1,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	provider: "my_library",
	version: "1.2.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	name: "release-notes",
	visibility: "PRIVATE",
	state: "published",
});
const marketVersion = SkillHubVersionMetadataV1Schema.parse({
	...version,
	skillId: "incident-summary",
	skillVersionId: "incident-summary-v2",
	name: "incident-summary",
	version: "2.0.0",
	provider: "market",
	visibility: "MARKET",
});

afterEach(cleanup);

async function renderWithRouter(content: ReactNode) {
	const root = createRootRoute();
	const contentRoute = createRoute({
		getParentRoute: () => root,
		path: "/",
		component: () => content,
	});
	const directoryRoute = createRoute({
		getParentRoute: () => root,
		path: "/skills",
		component: () => null,
	});
	const detailRoute = createRoute({
		getParentRoute: () => root,
		path: "/skills/$skillVersionId",
		component: () => null,
	});
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren([contentRoute, directoryRoute, detailRoute]),
	});
	await router.load();
	render(<RouterProvider router={router} />);
	return router;
}

describe("SkillHubDirectoryScreen", () => {
	it("filters authorized metadata and links to an immutable version detail", async () => {
		const router = await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "ready", versions: [version, marketVersion] }}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Skill 目录" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("当前授权 2 个版本");
		expect(
			screen.getByRole("link", { name: "release-notes" }).getAttribute("href"),
		).toBe("/skills/release-notes-v1");

		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Skill" }), {
			target: { value: "incident" },
		});
		expect(screen.queryByRole("link", { name: "release-notes" })).toBeNull();
		expect(screen.getByRole("link", { name: "incident-summary" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			"当前授权 2 个版本，匹配 1 个",
		);

		fireEvent.change(screen.getByLabelText("来源"), {
			target: { value: "my_library" },
		});
		expect(screen.queryByRole("link", { name: "incident-summary" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
		expect(screen.getByRole("link", { name: "incident-summary" })).toBeTruthy();
		expect(router.state.location.pathname).toBe("/");
	});

	it("reports unavailable state and only offers retry for retryable failures", async () => {
		const retry = () => {};
		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "unavailable", retryable: true }}
				onRetry={retry}
			/>,
		);
		expect(
			screen.getByText("Skill 目录暂时无法读取，请稍后重试。"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
		cleanup();

		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "unavailable", retryable: false, reason: "denied" }}
				onRetry={retry}
			/>,
		);
		expect(
			screen.getByText("当前账号没有读取 Skill 目录的权限。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
	});
});

describe("SkillHubVersionScreen", () => {
	it("keeps package/object locations out of the metadata detail", async () => {
		await renderWithRouter(
			<SkillHubVersionScreen state={{ kind: "ready", version }} />,
		);
		expect(screen.getByRole("heading", { name: "release-notes" })).toBeTruthy();
		expect(screen.getByText("版本 ID")).toBeTruthy();
		expect(screen.getByText(version.packageDigest)).toBeTruthy();
		expect(
			screen.getByText(
				"详情只回读服务端授权的 metadata，不暴露包正文、对象存储地址或凭证。",
			),
		).toBeTruthy();
		expect(screen.queryByText(/s3|object|secret/i)).toBeNull();
	});
});
