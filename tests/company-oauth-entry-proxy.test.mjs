import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nginx = await readFile("apps/connection-web/nginx.conf", "utf8");
const locations = new Map(
	[...nginx.matchAll(/location\s+([^{}]+)\{([^{}]*)\}/g)].map((m) => [
		m[1].trim(),
		m[2],
	]),
);

test("native company admission checks only human HTML routes", () => {
	for (const path of [
		"/connection/",
		"^~ /connection/pat-bindings/",
		"= /oauth/authorize",
	]) {
		const block = locations.get(path);
		assert.ok(block, path);
		assert.match(block, /auth_request \/_connection_company_entry;/);
		assert.match(block, /error_page 401 = @connection_company_login;/);
	}
	for (const path of [
		"= /connection/",
		"= /connection/index.html",
		"= /connection/install.css",
		"^~ /connection/agent/",
		"= /connection/help",
		"= /connection/help/user-manual.md",
		"^~ /connection/v1/",
		"= /connection/internal/v1/action-calls",
		"= /oauth/callback",
	]) {
		const block = locations.get(path);
		assert.ok(block, path);
		assert.doesNotMatch(block, /auth_request/);
	}
	const api = [...locations].find(([path]) => path.startsWith("~ ^/(api/"));
	assert.ok(api);
	assert.doesNotMatch(api[1], /auth_request/);
});

test("internal check and company restart never forward passwords or replay a POST", () => {
	const check = locations.get("= /_connection_company_entry");
	assert.ok(check);
	assert.match(check, /internal;/);
	assert.match(
		check,
		/proxy_pass http:\/\/connection-api:3002\/api\/v1\/connection\/identity\/oauth\/entry\/check;/,
	);
	assert.match(check, /proxy_pass_request_body off;/);
	const restart = locations.get("@connection_company_login");
	assert.ok(restart);
	assert.match(restart, /proxy_method GET;/);
	assert.match(restart, /proxy_pass_request_body off;/);
	assert.match(restart, /proxy_set_header Content-Length "";/);
	assert.match(
		restart,
		/proxy_set_header X-Connection-Return-To \$request_uri;/,
	);
	assert.match(
		restart,
		/proxy_set_header X-Connection-Original-Method \$request_method;/,
	);
	assert.match(
		restart,
		/rewrite \^ \/api\/v1\/connection\/identity\/oauth\/entry\? break;/,
	);
});
