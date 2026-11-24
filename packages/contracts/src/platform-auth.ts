import { z } from "zod";

export {
	PlatformLoginRequestV1Schema,
	platformAuthOpenApiPathsV1,
} from "./platform-auth-v1.ts";

export const platformAuthOpenApiPathsV2 = {
	"/auth/oidc/login": {
		get: {
			operationId: "beginPlatformOidcLogin",
			summary: "Start company sign-in",
			responses: {
				303: { description: "Redirect to the configured identity provider" },
				400: { description: "Invalid login request" },
				503: { description: "Identity provider unavailable" },
			},
		},
	},
	"/auth/oidc/callback": {
		get: {
			operationId: "completePlatformOidcLogin",
			requestParams: {
				query: z.object({ code: z.string().min(1), state: z.string().min(1) }),
			},
			summary: "Complete the browser-bound OIDC transaction",
			responses: {
				303: { description: "Session established; redirect to the workspace" },
				400: { description: "Missing or invalid browser transaction" },
				401: { description: "Identity rejected" },
				503: { description: "Identity or session authority unavailable" },
			},
		},
	},
	"/auth/oidc/backchannel-logout": {
		post: {
			operationId: "receivePlatformOidcLogout",
			summary: "Revoke sessions for a signed OIDC logout notification",
			requestBody: {
				required: true,
				content: {
					"application/x-www-form-urlencoded": {
						schema: z.object({ logout_token: z.string().min(1) }),
					},
				},
			},
			responses: {
				200: { description: "Notification processed" },
				400: { description: "Invalid logout token or form" },
				503: { description: "Verification or revocation unavailable" },
			},
		},
	},
	"/auth/logout": {
		post: {
			operationId: "logoutPlatformEmployeeV1",
			summary: "Revoke the current Platform browser session",
			requestParams: {
				header: z.strictObject({ "X-Platform-CSRF": z.literal("1") }),
			},
			security: [{ PlatformSession: [] }],
			responses: {
				204: { description: "Session revoked and cookie cleared" },
				400: { description: "Malformed logout request" },
				403: { description: "Origin or CSRF check rejected" },
				503: { description: "Session authority unavailable" },
			},
		},
	},
};
