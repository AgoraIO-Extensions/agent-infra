import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	IssuePersonalApiCredentialV2Responses,
	PersonalApiCredentialMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import { ApiCredentialsScreen } from "./api-credentials-screen.js";

const metadata: PersonalApiCredentialMetadataV1 = {
	credentialId: "credential-1",
	createdAt: "2026-10-10T00:00:00Z",
	expiresAt: null,
	lastUsedAt: null,
	revokedAt: null,
	scopes: ["agent:read"],
};

describe("ApiCredentialsScreen", () => {
	afterEach(cleanup);

	it("renders metadata without exposing credential material", () => {
		render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [metadata] }}
			/>,
		);

		expect(screen.getByText("credential-1")).toBeTruthy();
		expect(screen.queryByText(/papi_/)).toBeNull();
	});

	it("shows first-delivery material once and explains replay behavior", async () => {
		const onIssue = vi
			.fn<
				(body: {
					scopes: (typeof metadata.scopes)[number][];
					expiresAt: string | null;
				}) => Promise<IssuePersonalApiCredentialV2Responses[201]>
			>()
			.mockResolvedValue({
				credential: "papi_1234567890123456789012345678901234567890123",
				metadata,
				replayed: false,
			});
		render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [] }}
				onIssue={onIssue}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "签发个人凭证" }));
		await waitFor(() => expect(screen.getByText(/papi_/)).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "关闭一次性凭证提示" }));
		fireEvent.click(screen.getByRole("button", { name: "签发个人凭证" }));
		await waitFor(() => expect(onIssue).toHaveBeenCalledTimes(2));
	});
});
