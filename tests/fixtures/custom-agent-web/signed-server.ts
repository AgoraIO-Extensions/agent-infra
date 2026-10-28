import { createPublicKey, verify } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";

export const ownEntryPage =
	'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>自定义应用</title></head><body><main><h1>自定义应用</h1><p>已通过应用身份验证</p><button id="check">读取服务状态</button><p id="result"></p></main><script>document.getElementById(\'check\').onclick=async()=>{const r=await fetch(\'/api/check\');if(r.ok)document.getElementById(\'result\').textContent=(await r.json()).message;};</script></body></html>';
const loginPage =
	"<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>登录自定义应用</title></head><body><form><label>应用访问凭证<input name=\"token\" type=\"password\" autocomplete=\"off\"></label><button>登录</button><p id=\"error\"></p></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.querySelector('input').value})});if(r.ok)location.assign('/app');else document.getElementById('error').textContent='无法登录';};</script></body></html>";
export const ownEntryResult = {
	status: "ready",
	message: "Hello from application service",
};

type Configuration = {
	issuer: string;
	audience: string;
	publicKey: string;
	role: "single" | "web" | "api";
	backend?: string;
};
type Identity = { status: 200 | 401 | 403; token?: string };
const cookieName = "__Host-custom-entry";

export function createOwnEntryServer(configuration: Configuration) {
	const key = createPublicKey(configuration.publicKey);
	if (
		key.asymmetricKeyType !== "ed25519" ||
		!configuration.issuer ||
		!configuration.audience
	)
		throw new Error("OWN_ENTRY_CONFIGURATION_INVALID");
	if (
		configuration.role === "web" &&
		(!configuration.backend ||
			!/^http:\/\/agent-[a-f0-9]{32}-api:3003$/u.test(configuration.backend))
	)
		throw new Error("OWN_ENTRY_BACKEND_INVALID");
	function identity(token: unknown): Identity {
		if (
			typeof token !== "string" ||
			token.length > 8192 ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
		)
			return { status: 401 };
		try {
			const [header, body, signature] = token.split(".");
			const algorithm = JSON.parse(
				Buffer.from(header, "base64url").toString("utf8"),
			);
			if (
				algorithm.alg !== "EdDSA" ||
				algorithm.typ !== "JWT" ||
				Object.keys(algorithm).length !== 2 ||
				!verify(
					null,
					Buffer.from(`${header}.${body}`),
					key,
					Buffer.from(signature, "base64url"),
				)
			)
				return { status: 401 };
			const claims = JSON.parse(
				Buffer.from(body, "base64url").toString("utf8"),
			);
			const now = Math.floor(Date.now() / 1000);
			if (
				claims.iss !== configuration.issuer ||
				claims.aud !== configuration.audience ||
				typeof claims.sub !== "string" ||
				!claims.sub ||
				!Number.isSafeInteger(claims.iat) ||
				!Number.isSafeInteger(claims.exp) ||
				claims.iat > now ||
				claims.exp <= now ||
				claims.exp - claims.iat > 3600 ||
				!Array.isArray(claims.permissions)
			)
				return { status: 401 };
			return {
				status: claims.permissions.includes("web:read") ? 200 : 403,
				token,
			};
		} catch {
			return { status: 401 };
		}
	}
	function credential(request: IncomingMessage): string | undefined {
		if (request.headers.authorization !== undefined)
			return /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(
				request.headers.authorization,
			)?.[1];
		const cookies = (request.headers.cookie ?? "")
			.split(";")
			.map((value) => value.trim())
			.filter((value) => value.startsWith(`${cookieName}=`));
		return cookies.length === 1
			? cookies[0].slice(cookieName.length + 1)
			: undefined;
	}
	function send(
		response: ServerResponse,
		status: number,
		body = "",
		type = "text/plain",
	) {
		response.writeHead(status, {
			"content-type": type,
			"content-length": Buffer.byteLength(body),
			"cache-control": "no-store",
		});
		response.end(body);
	}
	async function handle(request: IncomingMessage, response: ServerResponse) {
		const pathname = new URL(request.url ?? "/", "http://application").pathname;
		if (request.method === "GET" && pathname === "/healthz") {
			send(response, 200, '{"status":"ready"}', "application/json");
			return;
		}
		if (
			request.method === "GET" &&
			pathname === "/" &&
			configuration.role !== "api"
		) {
			send(response, 200, loginPage, "text/html; charset=utf-8");
			return;
		}
		if (
			request.method === "POST" &&
			pathname === "/auth/login" &&
			configuration.role !== "api"
		) {
			const origin = request.headers.origin;
			if (origin !== `https://${request.headers.host}`) {
				send(response, 403);
				return;
			}
			let bytes = "";
			for await (const part of request) {
				bytes += part.toString();
				if (Buffer.byteLength(bytes) > 8192) {
					send(response, 413);
					return;
				}
			}
			let token: unknown;
			try {
				token = JSON.parse(bytes).token;
			} catch {
				send(response, 400);
				return;
			}
			const authenticated = identity(token);
			if (authenticated.status !== 200) {
				send(response, authenticated.status);
				return;
			}
			response.setHeader(
				"set-cookie",
				`${cookieName}=${authenticated.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
			);
			send(response, 204);
			return;
		}
		if (request.method !== "GET") {
			send(response, 405);
			return;
		}
		const authenticated = identity(credential(request));
		if (authenticated.status !== 200) {
			send(response, authenticated.status);
			return;
		}
		if (pathname === "/app" && configuration.role !== "api") {
			send(response, 200, ownEntryPage, "text/html; charset=utf-8");
			return;
		}
		if (pathname === "/api/check") {
			let result = ownEntryResult;
			if (configuration.role === "web") {
				const upstream = await fetch(`${configuration.backend}/api/check`, {
					headers: { authorization: `Bearer ${authenticated.token}` },
					redirect: "error",
					signal: AbortSignal.timeout(5000),
				});
				if (upstream.status !== 200) {
					send(response, 502);
					return;
				}
				const value = await upstream.json();
				if (JSON.stringify(value) !== JSON.stringify(ownEntryResult)) {
					send(response, 502);
					return;
				}
				result = value;
			}
			send(response, 200, JSON.stringify(result), "application/json");
			return;
		}
		send(response, 404);
	}
	return createServer((request, response) => {
		void handle(request, response).catch(() => {
			if (!response.headersSent) send(response, 503);
			else response.destroy();
		});
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const role = process.env.CUSTOM_ENTRY_ROLE ?? "single";
		if (!["single", "web", "api"].includes(role)) throw new Error();
		const prefix = /^(agent-[a-f0-9]{32})-web-/u.exec(
			process.env.HOSTNAME ?? "",
		)?.[1];
		const server = createOwnEntryServer({
			issuer: process.env.CUSTOM_ENTRY_ISSUER ?? "",
			audience: process.env.CUSTOM_ENTRY_AUDIENCE ?? "",
			publicKey: process.env.CUSTOM_ENTRY_PUBLIC_KEY ?? "",
			role: role as Configuration["role"],
			backend: prefix ? `http://${prefix}-api:3003` : undefined,
		});
		server.listen(3003, "0.0.0.0");
	} catch {
		process.stderr.write("OWN_ENTRY_CONFIGURATION_INVALID\n");
		process.exitCode = 1;
	}
}
