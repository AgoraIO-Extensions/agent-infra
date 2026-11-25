import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execCredential } from "../deploy/ack/github-oidc-credential.ts";
import {
	acceptOutcome,
	admissionError,
	diffChanges,
	gateSummary,
	historySummary,
	kubeconfig,
	main,
	parseInputs,
	planApproval,
	sourceNeeds,
	summaryMarkdown,
} from "../deploy/ack/production-deploy.ts";

const helmSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const sourceSha = "c".repeat(40);

test("inputs accept only known commands, a full main commit and a rollback revision", () => {
	assert.deepEqual(parseInputs({ DEPLOY_COMMAND: "status" }), {
		command: "status",
	});
	assert.deepEqual(
		parseInputs({ DEPLOY_COMMAND: "deploy", DEPLOY_HELM_COMMIT: helmSha }),
		{ command: "deploy", helmCommit: helmSha },
	);
	assert.deepEqual(
		parseInputs({ DEPLOY_COMMAND: "rollback", DEPLOY_REVISION: "111" }),
		{ command: "rollback", revision: 111 },
	);
	for (const env of [
		{ DEPLOY_COMMAND: "cutover" },
		{ DEPLOY_COMMAND: "destroy" },
		{ DEPLOY_COMMAND: "deploy", DEPLOY_HELM_COMMIT: "main" },
		{ DEPLOY_COMMAND: "deploy", DEPLOY_HELM_COMMIT: "A".repeat(40) },
		{ DEPLOY_COMMAND: "deploy", DEPLOY_HELM_COMMIT: helmSha.slice(0, 12) },
		{ DEPLOY_COMMAND: "rollback" },
		{ DEPLOY_COMMAND: "rollback", DEPLOY_REVISION: "0" },
		{ DEPLOY_COMMAND: "rollback", DEPLOY_REVISION: "1; true" },
		{ DEPLOY_COMMAND: "deploy", DEPLOY_REVISION: "3" },
	])
		assert.throws(
			() => parseInputs(env),
			/DEPLOY_INPUT_INVALID/u,
			JSON.stringify(env),
		);
});

test("source checkout and build follow the command and phase", () => {
	assert.deepEqual(sourceNeeds("status", "plan"), {
		checkout: false,
		build: false,
	});
	assert.deepEqual(sourceNeeds("deploy", "plan"), {
		checkout: true,
		build: false,
	});
	assert.deepEqual(sourceNeeds("deploy", "apply"), {
		checkout: true,
		build: true,
	});
	assert.deepEqual(sourceNeeds("verify", "plan"), {
		checkout: true,
		build: true,
	});
	assert.deepEqual(sourceNeeds("rollback", "apply"), {
		checkout: false,
		build: false,
	});
});

test("approval: rollback always, deploy on gate reasons, re-checked at apply", () => {
	assert.deepEqual(planApproval("rollback"), {
		required: true,
		reasons: ["rollback"],
	});
	assert.deepEqual(planApproval("deploy", []), {
		required: false,
		reasons: [],
	});
	assert.deepEqual(planApproval("deploy", ["migrations-pending"]), {
		required: true,
		reasons: ["migrations-pending"],
	});
	assert.deepEqual(planApproval("diff", ["migrations-pending"]), {
		required: false,
		reasons: [],
	});
	const base = {
		command: "deploy",
		approved: false,
		plannedReasons: [],
		currentReasons: [],
	};
	assert.equal(admissionError(base), undefined);
	assert.match(
		admissionError({ ...base, currentReasons: ["active-executions"] }),
		/not approved/u,
	);
	assert.equal(
		admissionError({
			...base,
			approved: true,
			plannedReasons: ["migrations-pending"],
			currentReasons: ["migrations-pending"],
		}),
		undefined,
	);
	assert.match(
		admissionError({
			...base,
			approved: true,
			plannedReasons: ["migrations-pending"],
			currentReasons: ["migrations-pending", "active-executions"],
		}),
		/new approval reasons since the plan: active-executions/u,
	);
	assert.match(
		admissionError({ ...base, command: "rollback" }),
		/rollback needs approval/u,
	);
	assert.equal(
		admissionError({ ...base, command: "rollback", approved: true }),
		undefined,
	);
});

test("the kubeconfig carries no token, only the OIDC exec plugin", () => {
	const config = JSON.parse(
		kubeconfig(
			"audience-1",
			"/x/github-oidc-credential.ts",
			"/ca.crt",
			"/usr/bin/node",
		),
	);
	assert.equal(
		config.clusters[0].cluster.server,
		"https://kubernetes.default.svc",
	);
	assert.equal(config.clusters[0].cluster["certificate-authority"], "/ca.crt");
	assert.deepEqual(config.users[0].user, {
		exec: {
			apiVersion: "client.authentication.k8s.io/v1",
			command: "/usr/bin/node",
			args: ["/x/github-oidc-credential.ts", "audience-1"],
			interactiveMode: "Never",
		},
	});
});

test("the exec credential renews a minute before the token expires", () => {
	const now = Date.UTC(2026, 10, 25, 0, 0, 0);
	const jwt = (claims) =>
		`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
	const credential = JSON.parse(
		execCredential(jwt({ exp: now / 1000 + 600 }), now),
	);
	assert.equal(credential.kind, "ExecCredential");
	assert.equal(credential.status.expirationTimestamp, "2026-11-25T00:09:00Z");
	assert.equal(
		JSON.parse(execCredential(jwt({ exp: now / 1000 }), now)).status
			.expirationTimestamp,
		"2026-11-25T00:00:01Z",
	);
	assert.throws(() => execCredential(jwt({}), now), /no expiry/u);
	assert.throws(() => execCredential("opaque", now), /not a JWT/u);
});

test("public receipt fields keep counts, names and booleans only", () => {
	const { reasons, summary } = gateSummary({
		kind: "agent-infra-deploy-gate",
		approvalReasons: ["active-executions"],
		rolls: ["worker"],
		activeExecutions: 2,
		migrations: {
			platform: { pending: 0, databaseAhead: false },
			directory: { error: "psql: connection to 10.0.0.5 failed" },
		},
	});
	assert.deepEqual(reasons, ["active-executions"]);
	assert.deepEqual(summary, {
		rolls: ["worker"],
		activeExecutions: 2,
		migrations: {
			platform: { pending: 0, databaseAhead: false },
			directory: { unreadable: true },
		},
	});
	assert.throws(
		() =>
			gateSummary({
				kind: "agent-infra-deploy-gate",
				approvalReasons: ["x; rm"],
				rolls: [],
			}),
		/DEPLOY_GATE_INVALID/u,
	);
	assert.deepEqual(
		diffChanges(
			"agent-infra, agent-infra-api, Deployment (apps) has changed:\n-  image: a\n+  image: b\nagent-infra, x, Secret () has been added:\n",
		),
		["Deployment/agent-infra-api changed", "Secret/x added"],
	);
	assert.deepEqual(
		acceptOutcome({
			passed: true,
			origin: "https://internal.example",
			templates: {
				codex: { passed: true, sessionId: "s-1" },
				pi: { passed: false },
			},
		}),
		{ passed: true, templates: { codex: true, pi: false } },
	);
	assert.deepEqual(
		historySummary([
			{
				revision: 112,
				status: "deployed",
				updated: "2026-11-25T11:09:19.293766+08:00",
				description: "Upgrade complete",
			},
		]),
		[
			{
				revision: 112,
				status: "deployed",
				updated: "2026-11-25T11:09:19.293766+08:00",
			},
		],
	);
	const markdown = summaryMarkdown({
		schemaVersion: 1,
		kind: "agent-infra-production-deploy",
		phase: "plan",
		command: "deploy",
		helmCommit: helmSha,
		sourceSha,
		revisionBefore: 112,
		approval: { required: true, reasons: ["active-executions"] },
		gate: summary,
		steps: [{ name: "gate", exitCode: 0, seconds: 3 }],
		passed: true,
		log: "deploy-log-1-1-plan",
	});
	assert.match(markdown, /required: active-executions/u);
	assert.match(markdown, /directory unreadable/u);
	assert.doesNotMatch(markdown, /10\.0\.0\.5|psql/u);
});

// End to end through main() with stub kubectl, git, helm, pnpm and a stub deploy.sh that records calls.
function harness({ main: remoteMain = helmSha, gateReasons = [] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "production-deploy-"));
	const bin = join(root, "bin");
	const temp = join(root, "temp");
	const fixture = join(root, "fixture");
	mkdirSync(bin);
	mkdirSync(temp);
	mkdirSync(join(fixture, "agent-infra", "environments", "prod"), {
		recursive: true,
	});
	writeFileSync(
		join(fixture, "agent-infra", "environments", "prod", "lane.json"),
		JSON.stringify({
			release: "agent-infra",
			namespace: "agent-infra",
			source: { sha: sourceSha },
		}),
	);
	const calls = join(root, "calls");
	writeFileSync(calls, "");
	writeFileSync(
		join(fixture, "agent-infra", "deploy.sh"),
		`#!/usr/bin/env bash
echo "deploy.sh $*" >> ${JSON.stringify(calls)}
echo "pod agent-infra-api-1 10.0.1.2 cn-hangzhou.10.0.1.219"
if [[ "$2" == gate ]]; then
  printf '%s' '${JSON.stringify({ kind: "agent-infra-deploy-gate", approvalReasons: gateReasons, rolls: ["api"], activeExecutions: 0, migrations: {} })}' > "$4"
fi
if [[ "$2" == diff ]]; then echo "agent-infra, agent-infra-api, Deployment (apps) has changed:"; fi
`,
	);
	chmodSync(join(fixture, "agent-infra", "deploy.sh"), 0o755);
	const secret = {
		data: Object.fromEntries(
			Object.entries({
				"helm-repository": "ssh://git@deploy.invalid/ai/helm.git",
				"helm-deploy-key": "KEY",
				"known-hosts": "deploy.invalid ssh-ed25519 AAAA",
			}).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
		),
	};
	const stub = (name, body) => {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub(
		"kubectl",
		`case "$*" in
  *"get secret production-deployer"*) printf '%s' '${JSON.stringify(secret)}' ;;
  *"get secrets -l"*) printf '{"items":[]}' ;;
  *apply*) cat > ${JSON.stringify(join(root, "log-secret.json"))} ;;
esac`,
	);
	stub(
		"helm",
		`printf '[{"revision":112,"status":"deployed","updated":"2026-11-25T11:09:19+08:00"}]'`,
	);
	stub("pnpm", "exit 0");
	stub(
		"git",
		`case "$1" in
  ls-remote) printf '%s\\trefs/heads/main\\n' ${remoteMain} ;;
  clone) mkdir -p "\${@: -1}" && cp -R ${JSON.stringify(fixture)}/. "\${@: -1}/" ;;
  -C) case "$3" in
        rev-parse) case "$2" in *source) echo ${sourceSha} ;; *) echo ${remoteMain} ;; esac ;;
        *) exit 0 ;;
      esac ;;
esac`,
	);
	writeFileSync(join(root, "ca.crt"), "CA");
	const env = (extra) => ({
		PATH: `${bin}:${process.env.PATH}`,
		RUNNER_TEMP: temp,
		GITHUB_RUN_ID: "42",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_OUTPUT: join(root, "output"),
		GITHUB_STEP_SUMMARY: join(root, "summary"),
		KUBERNETES_OIDC_AUDIENCE: "audience-1",
		KUBERNETES_CA_FILE: join(root, "ca.crt"),
		...extra,
	});
	return {
		run: (phase, extra) => main(phase, env(extra)),
		calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
		receipt: () =>
			JSON.parse(readFileSync(join(temp, "deploy-receipt.json"), "utf8")),
		output: () =>
			existsSync(join(root, "output"))
				? readFileSync(join(root, "output"), "utf8")
				: "",
		summary: () => readFileSync(join(root, "summary"), "utf8"),
		logSecret: () =>
			JSON.parse(readFileSync(join(root, "log-secret.json"), "utf8")),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("status reads the cluster and keeps command output out of the public receipt", (t) => {
	const h = harness();
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "status" }), 0);
	assert.deepEqual(h.calls(), ["deploy.sh prod status"]);
	const receipt = h.receipt();
	assert.equal(receipt.helmCommit, helmSha);
	assert.equal(receipt.sourceSha, sourceSha);
	assert.equal(receipt.log, "deploy-log-42-1-plan");
	assert.match(h.output(), /^apply=false$/mu);
	for (const text of [JSON.stringify(receipt), h.summary()])
		assert.doesNotMatch(text, /10\.0\.1|deploy\.invalid|KEY/u);
	assert.equal(h.logSecret().metadata.namespace, "agent-infra-deployer");
});

test("a helm_commit that is not the current main is refused before deploy.sh runs", (t) => {
	const h = harness({ main: otherSha });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_HELM_COMMIT: helmSha }),
		1,
	);
	assert.deepEqual(h.calls(), []);
	assert.match(h.receipt().error, /DEPLOY_HELM_COMMIT_NOT_MAIN/u);
});

test("deploy plan reports approval reasons from the gate", (t) => {
	const h = harness({ gateReasons: ["migrations-pending"] });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 0);
	assert.deepEqual(
		h.calls().map((call) => call.split(" ").slice(0, 3).join(" ")),
		["deploy.sh prod gate", "deploy.sh prod diff"],
	);
	assert.match(h.output(), /^approval_required=true$/mu);
	assert.match(h.output(), /^approval_reasons=migrations-pending$/mu);
	assert.match(h.output(), /^apply=true$/mu);
	assert.deepEqual(h.receipt().changes, ["Deployment/agent-infra-api changed"]);
});

test("apply refuses to write without the approval the gate needs", (t) => {
	const h = harness({ gateReasons: ["active-executions"] });
	t.after(h.cleanup);
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "deploy",
			PLANNED_HELM_COMMIT: helmSha,
			PLANNED_REASONS: "",
			APPROVAL_RESULT: "skipped",
		}),
		1,
	);
	assert.deepEqual(
		h.calls().map((call) => call.split(" ")[2]),
		["gate"],
	);
	assert.match(h.receipt().error, /DEPLOY_APPROVAL_REQUIRED/u);
});

test("apply refuses when main moved after the plan", (t) => {
	const h = harness({ main: otherSha });
	t.after(h.cleanup);
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "deploy",
			PLANNED_HELM_COMMIT: helmSha,
			APPROVAL_RESULT: "skipped",
		}),
		1,
	);
	assert.deepEqual(h.calls(), []);
	assert.match(h.receipt().error, /DEPLOY_HELM_MAIN_MOVED/u);
});

test("rollback writes only after approval", (t) => {
	const h = harness();
	t.after(h.cleanup);
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "rollback",
			DEPLOY_REVISION: "111",
			PLANNED_HELM_COMMIT: helmSha,
			APPROVAL_RESULT: "skipped",
		}),
		1,
	);
	assert.deepEqual(h.calls(), []);
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "rollback",
			DEPLOY_REVISION: "111",
			PLANNED_HELM_COMMIT: helmSha,
			APPROVAL_RESULT: "success",
		}),
		0,
	);
	assert.deepEqual(h.calls(), ["deploy.sh prod rollback 111"]);
	assert.match(h.summary(), /revert the deployment repository commits/u);
});

test("an approved deploy runs deploy, verify and reports accept as skipped without accounts", (t) => {
	const h = harness();
	t.after(h.cleanup);
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "deploy",
			PLANNED_HELM_COMMIT: helmSha,
			PLANNED_REASONS: "",
			APPROVAL_RESULT: "skipped",
		}),
		0,
	);
	assert.deepEqual(
		h.calls().map((call) => call.split(" ")[2]),
		["gate", "deploy", "verify"],
	);
	assert.match(h.receipt().accept.skipped, /no acceptance\.json/u);
});
