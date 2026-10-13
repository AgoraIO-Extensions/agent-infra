// This Adapter is only for the company identity probe, never Provider execution.
export class CompanyOAuthIdentityClient {
	constructor(
		private readonly options: {
			clientId: string;
			clientSecret: string;
			fetch: typeof fetch;
		},
	) {}

	async readIdentity(code: string, redirectUri: string): Promise<unknown> {
		const deadline = AbortSignal.timeout(10_000);
		const token = await this.json("https://oauth.agoralab.co/oauth/token", {
			method: "POST",
			signal: deadline,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
			}).toString(),
		});
		if (!token || typeof token !== "object" || Array.isArray(token))
			throw new Error("Company OAuth response rejected");
		const value = token as Record<string, unknown>;
		if (
			typeof value.access_token !== "string" ||
			!/^[\x21-\x7e]{1,8192}$/.test(value.access_token) ||
			typeof value.token_type !== "string" ||
			value.token_type.toLowerCase() !== "bearer"
		)
			throw new Error("Company OAuth response rejected");
		return this.json("https://oauth.agoralab.co/api/v2/userInfo", {
			method: "GET",
			signal: deadline,
			headers: { authorization: `Bearer ${value.access_token}` },
		});
	}

	private async json(url: string, init: RequestInit): Promise<unknown> {
		const response = await this.options.fetch(url, {
			...init,
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Company OAuth request rejected");
		}
		// Bound decoded body bytes too; Content-Length alone is not authoritative.
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Company OAuth response rejected");
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > 65_536) throw new Error("Company OAuth response rejected");
				chunks.push(chunk.value);
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("Company OAuth response rejected");
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}
}
