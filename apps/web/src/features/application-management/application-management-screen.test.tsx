import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
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
});
