import { z } from "zod";

export const WecomApplicationCredentialsV1Schema = z.strictObject({
	state: z.string().min(1).max(1024),
	corporationId: z.string().min(1).max(1024),
	applicationId: z.string().regex(/^[1-9][0-9]{0,14}$/),
	secret: z.string().min(1).max(1024).meta({ writeOnly: true }),
	token: z.string().min(1).max(1024).meta({ writeOnly: true }),
	encodingAesKey: z
		.string()
		.regex(/^[A-Za-z0-9+/]{43}$/)
		.meta({ writeOnly: true }),
	takeoverConfirmed: z.boolean(),
});
