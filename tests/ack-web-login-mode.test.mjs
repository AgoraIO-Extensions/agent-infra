import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

function render(...overrides) {
	return spawnSync(
		"helm",
		[
			"template",
			"login-test",
			"deploy/ack/chart",
			"--show-only",
			"templates/web.yaml",
			...overrides,
		],
		{ encoding: "utf8" },
	);
}

for (const [expectedMode, overrides] of [
	["build", []],
	["oidc", ["--set-string", "platformWeb.loginMode=oidc"]],
]) {
	test(`ACK Web renders the ${expectedMode} login mode`, () => {
		const result = render(...overrides);
		assert.equal(result.status, 0, result.stderr);
		const deployment = parseAllDocuments(result.stdout)
			.map((doc) => doc.toJSON())
			.find(
				(doc) =>
					doc.kind === "Deployment" && doc.metadata.name === "agent-infra-web",
			);
		const web = deployment.spec.template.spec.containers.find(
			(container) => container.name === "web",
		);
		assert.deepEqual(
			web.env.filter((item) => item.name === "PLATFORM_WEB_LOGIN_MODE"),
			[{ name: "PLATFORM_WEB_LOGIN_MODE", value: expectedMode }],
		);
	});
}

test("ACK rejects unsupported Web login modes before deploying", () => {
	const result = render("--set-string", "platformWeb.loginMode=other");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /loginMode/);
});
