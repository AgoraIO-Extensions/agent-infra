import { randomUUID } from "node:crypto";
import {
	type ConnectionOAuthService,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import { describe, expect, it, vi } from "vitest";

import { createConnectionOAuthApp } from "./oauth-routes";

describe("OAuth rejection diagnostics", () => {
	it.each([
		{ code: "invalid_grant" as const, status: 400 },
		{ code: "invalid_token" as const, status: 401 },
	])(
		"keeps $code responses and logs only safe protocol fields",
		async ({ code, status }) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const token = randomUUID();
			const description = "Invalid OAuth credentials";
			try {
				const app = createConnectionOAuthApp({
					issuer: "https://connection.example",
					resource: "https://connection.example/mcp",
					service: {
						refresh: async () => {
							throw new OAuthProtocolError(code, description, status);
						},
					} as unknown as ConnectionOAuthService,
				});
				const response = await app.request(`/oauth/token?secret=${token}`, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						authorization: `Bearer ${token}`,
					},
					body: new URLSearchParams({
						grant_type: "refresh_token",
						client_id: token,
						refresh_token: token,
						resource: `https://connection.example/mcp?secret=${token}`,
					}),
				});
				expect(response.status).toBe(status);
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(await response.json()).toEqual({
					error: code,
					error_description: description,
				});
				expect(warn).toHaveBeenCalledTimes(1);
				expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
					event: "connection_oauth_request_rejected",
					operation: "token",
					code,
					status,
				});
				expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
				expect(JSON.stringify(warn.mock.calls)).not.toContain(description);
			} finally {
				warn.mockRestore();
			}
		},
	);
});
