import { z } from "zod";

export const AuthLoginRequestV1Schema = z.strictObject({
	username: z.string().max(256),
	password: z.string().max(1024),
});

const AuthPrincipalV1Schema = z.strictObject({
	id: z.string().min(1),
	uid: z.string().min(1),
});

export const AuthLoginResponseV1Schema = z.strictObject({
	principal: AuthPrincipalV1Schema,
});

export const AuthSessionResponseV1Schema = z.strictObject({
	principal: AuthPrincipalV1Schema,
	csrfToken: z.string().min(1),
});

export const AuthErrorV1Schema = z.strictObject({
	error: z.enum([
		"Forbidden",
		"Invalid request",
		"Login failed",
		"Login temporarily unavailable",
		"Login unavailable",
		"Unauthorized",
		"Unavailable",
	]),
});

export function authError(error: z.infer<typeof AuthErrorV1Schema>["error"]) {
	return AuthErrorV1Schema.parse({ error });
}
