// kubectl/Helm exec credential plugin for the in-cluster deploy executor (workflow Spec §10.3).
// It requests a GitHub Actions OIDC token for the given audience and returns it as the bearer
// token; the API server maps its `sub` to the RBAC user. Clients re-run the plugin when the
// token is about to expire, so long Helm waits keep working. The token is never printed elsewhere.
//
//   node deploy/ack/github-oidc-credential.ts <audience>
import { pathToFileURL } from "node:url";

export function execCredential(token: string, now: number): string {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("OIDC token is not a JWT");
	const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
	if (typeof exp !== "number" || !Number.isFinite(exp)) throw new Error("OIDC token has no expiry");
	// Renew a minute early; never report a time already past.
	const expires = Math.max(now + 1_000, exp * 1_000 - 60_000);
	return JSON.stringify({
		apiVersion: "client.authentication.k8s.io/v1",
		kind: "ExecCredential",
		status: { token, expirationTimestamp: new Date(expires).toISOString().replace(/\.\d{3}Z$/u, "Z") },
	});
}

async function main(): Promise<void> {
	const audience = process.argv[2] ?? "";
	const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
	const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
	if (!/^[\w.:-]{1,128}$/u.test(audience)) throw new Error("usage: github-oidc-credential.ts <audience>");
	if (!url.startsWith("https://") || !requestToken) throw new Error("the job needs permissions: id-token: write");
	const request = new URL(url);
	request.searchParams.set("audience", audience);
	const response = await fetch(request, {
		headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`OIDC token request failed with HTTP ${response.status}`);
	const { value } = (await response.json()) as { value?: unknown };
	if (typeof value !== "string") throw new Error("OIDC token response has no value");
	process.stdout.write(`${execCredential(value, Date.now())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		console.error(`github-oidc-credential: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
