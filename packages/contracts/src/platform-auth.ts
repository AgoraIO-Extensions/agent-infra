import { z } from "zod";

export const PlatformLoginRequestV1Schema = z.strictObject({
	login: z.string().min(1).max(256),
	password: z.string().min(1).max(4096).meta({ writeOnly: true }),
});

export const platformAuthOpenApiPathsV1 = {
	"/auth/login": {
		post: {
			operationId: "loginPlatformEmployeeV1",
			summary: "Bind an employee password and issue a Platform browser session",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: PlatformLoginRequestV1Schema },
				},
			},
			responses: {
				204: { description: "Session issued in a secure cookie" },
				400: { description: "Malformed login request" },
				401: { description: "Credentials or current account rejected" },
				403: { description: "Request origin rejected" },
				503: { description: "Identity or session authority unavailable" },
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
