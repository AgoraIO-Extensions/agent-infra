import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
	readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Web 镜像入口脚本渲染 nginx 配置时读取的模板路径（#2975）。 */
function entrypointTemplatePath() {
	const match = read("apps/web/ack-web-entrypoint.sh").match(
		/\s(\/etc\/nginx\/\S+\.template)\s*>\s*\/tmp\/nginx-conf\//,
	);
	assert.ok(match, "Web 入口脚本必须从固定模板渲染 /tmp/nginx-conf");
	return match[1];
}

/** 本地 Compose 把本地渲染的 nginx 配置挂到的容器内路径。 */
function localComposeNginxTarget() {
	const match = read("deploy/local/compose.yaml").match(
		/\$\{PLATFORM_LOCAL_NGINX_CONFIG:[^}]*\}:([^:\s]+):ro/,
	);
	assert.ok(match, "本地 Compose 必须挂载 PLATFORM_LOCAL_NGINX_CONFIG");
	return match[1];
}

// #3005：#2975 之后镜像只加载入口脚本从模板渲染的配置；本地 Compose 仍挂到旧的
// default.conf，nginx 改用镜像内的 ACK 模板，解析不到 agent-infra-api，Web 起不来。
test("local Compose mounts its nginx configuration where the Web entrypoint reads the template", () => {
	assert.equal(localComposeNginxTarget(), entrypointTemplatePath());
});

test("the Web image installs the template the entrypoint reads and only loads the rendered output", () => {
	const template = entrypointTemplatePath();
	assert.match(
		read("apps/web/Dockerfile"),
		new RegExp(
			`COPY apps/web/nginx\\.conf ${template.replaceAll(".", "\\.")}\\n`,
		),
	);
	assert.match(
		read("apps/web/nginx-main.conf"),
		/include \/tmp\/nginx-conf\/\*\.conf;/,
	);
});

test("local Compose gives the directory sidecar a one CPU default budget", () => {
	assert.match(
		read("deploy/local/compose.yaml"),
		/enterprise-directory-sync:[\s\S]*?cpus: \$\{PLATFORM_LOCAL_DIRECTORY_CPUS:-1\.0\}/,
	);
});
