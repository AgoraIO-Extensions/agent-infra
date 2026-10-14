import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import test from "node:test";
import ts from "typescript";

import { parse } from "yaml";

const dockerfiles = new Map([
	["web", "apps/web/Dockerfile"],
	["connection-web", "apps/connection-web/Dockerfile"],
	["platform-api", "apps/platform-api/Dockerfile"],
	["platform-worker", "apps/platform-worker/Dockerfile"],
	["connection-api", "apps/connection-api/Dockerfile"],
]);

const digestPattern = /@sha256:[a-f0-9]{64}$/;

test("API Docker COPY includes the static local import closure of production entries", async () => {
	const dockerfile = await readFile("apps/connection-api/Dockerfile", "utf8");
	const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+/gm)].map(
		(match) => match[1],
	);
	const config = ts.createSourceFile(
		"tsdown.config.ts",
		await readFile("apps/connection-api/tsdown.config.ts", "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const pending = [];
	function entries(node) {
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(config) === "entry" &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			for (const entry of node.initializer.elements)
				if (ts.isStringLiteral(entry))
					pending.push(posix.join("apps/connection-api", entry.text));
		}
		ts.forEachChild(node, entries);
	}
	entries(config);
	assert.ok(pending.length > 0);
	const visited = new Set();
	while (pending.length) {
		const file = pending.pop();
		if (visited.has(file)) continue;
		visited.add(file);
		assert.ok(
			copied.some((source) => source === file || file.startsWith(`${source}/`)),
			`${file} is missing from the Docker build context`,
		);
		const module = ts.createSourceFile(
			file,
			await readFile(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		for (const statement of module.statements) {
			if (
				!ts.isImportDeclaration(statement) &&
				!ts.isExportDeclaration(statement)
			)
				continue;
			const specifier = statement.moduleSpecifier;
			if (
				!specifier ||
				!ts.isStringLiteral(specifier) ||
				!specifier.text.startsWith(".")
			)
				continue;
			const dependency = posix.join(posix.dirname(file), specifier.text);
			pending.push(posix.extname(dependency) ? dependency : `${dependency}.ts`);
		}
	}
});

test("Connection access logs exclude callback queries and Referer", async () => {
	const nginx = await readFile("apps/connection-web/nginx-main.conf", "utf8");
	const format = nginx.match(/log_format connection_safe ([^;]+);/)?.[1];
	assert.ok(format);
	assert.match(format, /\$request_method \$uri \$status/);
	assert.doesNotMatch(
		format,
		/\$request\b|\$request_uri\b|\$args\b|\$http_referer\b/,
	);
	assert.match(nginx, /access_log \/dev\/stdout connection_safe;/);
});

test("deployment images pin every base image by digest", async () => {
	for (const [service, path] of dockerfiles) {
		const dockerfile = await readFile(path, "utf8");
		const images = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(
			(match) => match[1],
		);

		assert.ok(images.length > 0, `${service} must declare a base image`);
		for (const image of images) {
			assert.match(
				image,
				digestPattern,
				`${service} must pin ${image} by digest`,
			);
		}
	}
});

test("deployment images select an explicit non-root runtime user", async () => {
	const expectedUsers = new Map([
		["web", "nginx"],
		["connection-web", "nginx"],
		["platform-api", "node"],
		["platform-worker", "node"],
		["connection-api", "node"],
	]);

	for (const [service, path] of dockerfiles) {
		const dockerfile = await readFile(path, "utf8");
		const runtimeStage = dockerfile.slice(
			dockerfile.lastIndexOf("\nFROM ") + 1,
		);
		assert.match(
			runtimeStage,
			new RegExp(`^USER ${expectedUsers.get(service)}$`, "m"),
			`${service} must select its non-root runtime user in the final stage`,
		);
	}
});

test("Node runtime images contain only production deployment artifacts", async () => {
	for (const service of ["platform-api", "platform-worker", "connection-api"]) {
		const path = dockerfiles.get(service);
		const dockerfile = await readFile(path, "utf8");
		const manifest = JSON.parse(
			await readFile(`apps/${service}/package.json`, "utf8"),
		);
		const runtimeStage = dockerfile.slice(
			dockerfile.lastIndexOf("\nFROM ") + 1,
		);

		assert.equal(manifest.main, "dist/index.mjs");
		assert.deepEqual(manifest.files, ["dist"]);
		assert.match(
			dockerfile,
			new RegExp(
				`pnpm --filter @agent-infra/${service} deploy --prod --legacy /prod/${service}`,
			),
			`${service} must prepare a production-only deployment`,
		);
		assert.match(
			runtimeStage,
			new RegExp(
				`^COPY --from=builder --chown=node:node /prod/${service}/ \\./$`,
				"m",
			),
			`${service} must copy only its deployment into the runtime stage`,
		);
		assert.doesNotMatch(runtimeStage, /^COPY \. \.$/m);
	}
});

test("the production Connection builder excludes development fixture source", async () => {
	const dockerfile = await readFile("apps/connection-api/Dockerfile", "utf8");

	assert.doesNotMatch(dockerfile, /^COPY . .$/m);
	assert.doesNotMatch(dockerfile, /fixture|stub/i);
	assert.doesNotMatch(dockerfile, /src\/conformance(?:-app)?\.ts/);
	assert.match(dockerfile, /src\/runtime-app\.ts/);
	assert.doesNotMatch(dockerfile, /Dockerfile.development/);
	assert.ok(
		dockerfile.includes("COPY migrations/connection migrations/connection"),
		"production migrations must remain part of the controlled build input",
	);
});

test("the production Connection image excludes development provider fixtures", async () => {
	const dockerfile = await readFile("apps/connection-api/Dockerfile", "utf8");
	const productionCompose = parse(
		await readFile("docker-compose.production.yml", "utf8"),
	);

	assert.match(
		dockerfile,
		/^COPY apps\/connection-api\/src\/bootstrap-production\.ts /m,
	);
	assert.doesNotMatch(
		dockerfile,
		/^COPY apps\/connection-api\/src\/development\.ts /m,
	);
	assert.doesNotMatch(
		JSON.stringify(productionCompose.services),
		/CONNECTION_BUILD_MODE.*development/,
	);
});

test("local Compose exposes only the real PostgreSQL dependency", async () => {
	const compose = parse(await readFile("docker-compose.yml", "utf8"));
	assert.deepEqual(Object.keys(compose.services), ["postgres"]);
	assert.ok(compose.services.postgres.healthcheck);
});

test("Connection Web preserves every same-origin API route family", async () => {
	const nginx = await readFile("apps/connection-web/nginx.conf", "utf8");
	const vite = await readFile("apps/connection-web/vite.config.ts", "utf8");
	const installPage = await readFile(
		"apps/connection-web/public/connection/index.html",
		"utf8",
	);
	const llms = await readFile("apps/connection-web/public/llms.txt", "utf8");
	const appHtml = await readFile("apps/connection-web/index.html", "utf8");
	const directSessionApi = nginx.indexOf("location ^~ /connection/v1/");
	const delegatedApi = nginx.match(
		/location = \/connection\/internal\/v1\/action-calls \{([^}]+)\}/,
	)?.[1];
	assert.ok(delegatedApi, "Delegated calls must not fall through to the SPA");
	assert.match(delegatedApi, /proxy_pass http:\/\/connection-api:3002;/);
	assert.match(delegatedApi, /proxy_next_upstream off;/);
	const patBindingApi = nginx.indexOf("location ^~ /connection/pat-bindings/");
	const spaFallback = nginx.indexOf("location /connection/");

	assert.ok(directSessionApi >= 0, "nginx must proxy the Direct Session API");
	assert.ok(
		directSessionApi < spaFallback,
		"the Direct Session API must be matched before the Connection SPA",
	);
	assert.ok(patBindingApi >= 0, "nginx must proxy the PAT binding API");
	assert.ok(
		patBindingApi < spaFallback,
		"the PAT binding API must be matched before the Connection SPA",
	);
	assert.match(vite, /"\/connection\/v1"/);
	assert.match(vite, /"\/connection\/internal\/v1\/action-calls"/);
	assert.match(vite, /"\/connection\/pat-bindings"/);
	assert.match(nginx, /absolute_redirect off;/);
	assert.match(nginx, /location = \/connection/);
	assert.match(nginx, /location = \/oauth\/callback/);
	assert.match(nginx, /proxy_read_timeout 120s;/);
	assert.match(nginx, /proxy_next_upstream off;/);
	assert.match(
		installPage,
		/codex mcp add connection --url __CONNECTION_ORIGIN__\/mcp/,
	);
	assert.match(
		nginx,
		/sub_filter '__CONNECTION_ORIGIN__' '\$connection_public_scheme:\/\/\$http_host';/,
	);
	assert.match(
		installPage,
		/codex mcp login connection --scopes mcp --oauth-client-registration dcr/,
	);
	assert.match(installPage, /href="\/llms\.txt"/);
	assert.match(appHtml, /href="\/llms\.txt"/);
	assert.match(llms, /Installing and logging in do not grant access/);
	assert.doesNotMatch(llms, /bearer[_ -]?token|password\s*=/i);
});
