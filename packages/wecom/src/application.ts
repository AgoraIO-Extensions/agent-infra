/** Worker-only application credential validation. Only fixed provider URLs are used. */
export function createWecomApplicationAccessV1(
	options: { readonly fetch?: typeof fetch } = {},
) {
	const send = options.fetch ?? fetch;
	async function request(path: string, query: Record<string, string>) {
		const url = new URL(path, "https://qyapi.weixin.qq.com");
		for (const [key, value] of Object.entries(query))
			url.searchParams.set(key, value);
		const response = await send(url, {
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) throw new Error("WeCom application unavailable");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("WeCom application unavailable");
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				if (size > 65536) throw new Error("WeCom application unavailable");
				chunks.push(part.value);
			}
		} finally {
			await reader.cancel();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
			string,
			unknown
		>;
	}
	return {
		async token(credential: {
			corporationId: string;
			applicationId: string;
			secret: string;
		}): Promise<string | null> {
			try {
				const token = await request("/cgi-bin/gettoken", {
					corpid: credential.corporationId,
					corpsecret: credential.secret,
				});
				if (
					token.errcode === 40013 ||
					token.errcode === 40001 ||
					token.errcode === 40014
				)
					return null;
				if (
					token.errcode !== 0 ||
					typeof token.access_token !== "string" ||
					!token.access_token
				)
					throw new Error();
				const application = await request("/cgi-bin/agent/get", {
					access_token: token.access_token,
					agentid: credential.applicationId,
				});
				if (application.errcode === 301002 || application.errcode === 48002)
					return null;
				if (application.errcode !== 0) throw new Error();
				if (String(application.agentid) !== credential.applicationId)
					return null;
				return token.access_token;
			} catch {
				throw new Error("WeCom application unavailable");
			}
		},
	};
}
