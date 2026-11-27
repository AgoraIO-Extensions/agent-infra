import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { registerConnectionInstallationCallbackRoutesV1 } from "../../../apps/platform-api/src/http/connection-installation-callback-routes.js";
import { createTrustedProxyVerifier } from "../../../apps/platform-api/src/trusted-proxy.js";

const app = new Hono();
const publicOrigin =
	process.env.FIXTURE_PUBLIC_ORIGIN ?? "https://platform.test";
const callbackPath =
	process.env.FIXTURE_CALLBACK_PATH ?? "/api/connection-installations/callback";
app.on("GET", ["/api/fixture-proxy", "/auth/oidc/login"], (context) =>
	context.json({
		scheme: context.req.header("x-forwarded-proto"),
		authority: context.req.header("host"),
	}),
);
let claimed = false;
let claims = 0;
let forwards = 0;
let delivered = 0;
let exactPayload = false;
app.get("/api/fixture-health", (context) =>
	context.json({ claims, forwards, delivered, exactPayload }),
);
app.get("/api/fixture-close", (context) => {
	setTimeout(
		() =>
			server.close(() => {
				setInterval(() => {}, 1000);
			}),
		20,
	);
	return context.body(null, 204);
});
registerConnectionInstallationCallbackRoutesV1(app, {
	publicOrigin,
	callbackUrl: publicOrigin + callbackPath,
	issuer: "https://connection.test/",
	isTrustedProxyRequest: createTrustedProxyVerifier("s".repeat(43)),
	installation: {
		callback: {
			claim: async () => {
				claims++;
				if (claimed) return null;
				claimed = true;
				return {
					authorizationId: "synthetic-authorization",
					runtimeOrigin: "https://runtime.test:3443/",
					callbackPath: "/internal/runtime/oauth/v1/callback",
					attemptId: "synthetic-attempt",
					expiresAt: Date.now() + 60_000,
					issuer: "https://connection.test/",
				};
			},
			settle: async ({ status }: { status: string }) => {
				if (status === "delivered") delivered++;
				return true;
			},
		},
	} as never,
	forward: async ({ request, callbackPath, target }) => {
		forwards++;
		exactPayload =
			"code" in request &&
			request.code === "synthetic-callback-code-marker" &&
			request.state === "a".repeat(64) &&
			request.issuer === "https://connection.test/" &&
			callbackPath === "/internal/runtime/oauth/v1/callback" &&
			target.authorizationId === "synthetic-authorization";
		if (!exactPayload) throw Error("SYNTHETIC_BINDING_MISMATCH");
	},
});
const server = serve({ fetch: app.fetch, port: 3000, hostname: "0.0.0.0" });
