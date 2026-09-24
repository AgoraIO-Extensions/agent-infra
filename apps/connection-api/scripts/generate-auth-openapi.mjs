import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDocument } from "zod-openapi";
import {
	AuthErrorV1Schema,
	AuthLoginRequestV1Schema,
	AuthLoginResponseV1Schema,
	AuthSessionResponseV1Schema,
} from "../src/auth-schema.ts";

const path = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../openapi/auth.v1.openapi.json",
);
const json = (description, schema) => ({
	description,
	content: { "application/json": { schema } },
});
const forbidden = json("Origin or CSRF validation failed", AuthErrorV1Schema);
const unavailable = json("Connection login is unavailable", AuthErrorV1Schema);
const sessionCookieHeader = {
	"Set-Cookie": {
		description:
			"__Host-connection_session; HttpOnly; Secure; SameSite=Strict; Path=/",
		schema: { type: "string" },
	},
};
const originHeader = z.strictObject({ origin: z.string().min(1) });
const document = createDocument({
	openapi: "3.1.0",
	info: { title: "Connection Browser Authentication API", version: "1.0.0" },
	paths: {
		"/auth/login": {
			post: {
				operationId: "loginConnectionBrowser",
				requestParams: { header: originHeader },
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: AuthLoginRequestV1Schema },
					},
				},
				responses: {
					200: {
						...json("Browser Session cookie issued", AuthLoginResponseV1Schema),
						headers: sessionCookieHeader,
					},
					400: json("Invalid login request", AuthErrorV1Schema),
					401: json("Login rejected", AuthErrorV1Schema),
					403: forbidden,
					429: json("Login rate limited", AuthErrorV1Schema),
					503: unavailable,
				},
			},
		},
		"/auth/session": {
			get: {
				operationId: "getConnectionBrowserSession",
				security: [{ browserSession: [] }],
				responses: {
					200: json("Current Browser Session", AuthSessionResponseV1Schema),
					401: json("Browser Session is unavailable", AuthErrorV1Schema),
					503: unavailable,
				},
			},
		},
		"/auth/logout": {
			post: {
				operationId: "logoutConnectionBrowser",
				security: [{ browserSession: [] }],
				requestParams: {
					header: z.strictObject({
						origin: z.string().min(1),
						"x-csrf-token": z.string().min(1),
					}),
				},
				responses: {
					204: {
						description: "Browser Session revoked and cookie cleared",
						headers: sessionCookieHeader,
					},
					401: json("Browser Session is unavailable", AuthErrorV1Schema),
					403: forbidden,
					503: unavailable,
				},
			},
		},
	},
	components: {
		securitySchemes: {
			browserSession: {
				type: "apiKey",
				in: "cookie",
				name: "__Host-connection_session",
			},
		},
		schemas: {
			AuthErrorV1: AuthErrorV1Schema,
			AuthLoginRequestV1: AuthLoginRequestV1Schema,
			AuthLoginResponseV1: AuthLoginResponseV1Schema,
			AuthSessionResponseV1: AuthSessionResponseV1Schema,
		},
	},
});
const bytes = execFileSync("biome", ["format", "--stdin-file-path", path], {
	input: `${JSON.stringify(document, null, "\t")}\n`,
	encoding: "utf8",
});
if (process.argv[2] === "--write") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
} else if (process.argv[2] === "--check") {
	if ((await readFile(path, "utf8")) !== bytes)
		throw new Error("Connection auth OpenAPI artifact drifted");
} else {
	throw new Error("Expected --write or --check");
}
