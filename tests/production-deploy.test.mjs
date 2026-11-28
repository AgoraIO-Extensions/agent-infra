import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { execCredential } from "../deploy/ack/github-oidc-credential.ts";
import {
	acceptOutcome,
	admissionError,
	diffChanges,
	failClosedReasons,
	gateSummary,
	historySummary,
	imageCacheSummary,
	imageSummary,
	kubeconfig,
	parseInputs,
	planApproval,
	sourceNeeds,
	summaryMarkdown,
} from "../deploy/ack/production-deploy.ts";

const deployScript = fileURLToPath(
	new URL("../deploy/ack/production-deploy.ts", import.meta.url),
);
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
		...["latest", "v1.2", "v1.2.3-rc1", "1.2.3", "v1.2.3;true"].map(
			(version) => ({ DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: version }),
		),
		{
			DEPLOY_COMMAND: "rollback",
			DEPLOY_REVISION: "111",
			DEPLOY_VERSION: "v1.2.3",
		},
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
	assert.deepEqual(sourceNeeds("accept", "plan"), {
		checkout: true,
		build: false,
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
const internalPrefix = "registry.internal.invalid/team/agent-infra";
const imageCheck = (missing) => ({
	schemaVersion: 1,
	kind: "agent-infra-image-registry-check",
	prefix: internalPrefix,
	passed: !missing,
	checked: 2,
	images: [
		{
			repository: `${internalPrefix}/platform-api`,
			digest: `sha256:${"1".repeat(64)}`,
			status: "present",
		},
		{
			repository: `${internalPrefix}/agent-runtime-codex`,
			digest: `sha256:${"2".repeat(64)}`,
			status: missing ? "missing" : "present",
		},
	],
});

const syntheticSecret = Buffer.concat([
	Buffer.from("test-only-baseline-marker"),
	Buffer.from([0, 255, 10]),
]);

function harness({
	main: remoteMain = helmSha,
	gateReasons = [],
	missingImage = false,
	publication = true,
	settled = true,
	liveVersion,
	staleApi = false,
	legacy = false,
	historyReadable = true,
	installed = true,
	contract = true,
	promotionTag,
	acceptance = false,
	acceptExit = 0,
	acceptRevision = 112,
	postAcceptRevision,
	standardTemplateRegistry = false,
} = {}) {
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
			...(standardTemplateRegistry ? { standardTemplateRegistry: {} } : {}),
		}),
	);
	if (contract) {
		mkdirSync(join(fixture, "agent-infra/scripts"), { recursive: true });
		writeFileSync(
			join(fixture, "agent-infra/scripts/deployment-release.mjs"),
			"export const fixture=true;",
		);
	}
	const baseline = join(fixture, "agent-infra/.secrets/prod");
	mkdirSync(join(baseline, "material"), { recursive: true });
	writeFileSync(join(baseline, "material/key"), syntheticSecret);
	mkdirSync(join(baseline, "config/api"), { recursive: true });
	symlinkSync("../../material/key", join(baseline, "config/api/key"));
	writeFileSync(
		join(baseline, "config/api/template-validation-codex.json"),
		"synthetic preflight",
	);
	const releaseConfig = join(baseline, "release-config", sourceSha);
	for (const result of [
		"evidence/run",
		"worker/execution-capacity-profiles.json",
	]) {
		const dest = join(releaseConfig, result);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, "synthetic preflight");
	}
	const clusterBaseline = join(root, "cluster-baseline.json");
	const manifests = releaseManifests();
	const current = {
		source: {
			sha: sourceSha,
			repository: "AgoraIO-Extensions/agent-infra",
			releaseRun: 123,
			attempt: 1,
		},
		manifests,
		...(liveVersion ? { version: liveVersion } : {}),
	};
	mkdirSync(join(fixture, "agent-infra", "releases"), { recursive: true });
	for (const [name, manifest] of Object.entries(manifests))
		writeFileSync(
			join(fixture, "agent-infra", "releases", `${name}.json`),
			JSON.stringify(manifest),
		);
	writeFileSync(
		join(fixture, "agent-infra/environments/prod/release-migration.json"),
		JSON.stringify(current),
	);
	const calls = join(root, "calls");
	writeFileSync(calls, "");
	writeFileSync(
		join(fixture, "agent-infra", "deploy.sh"),
		`#!/usr/bin/env bash
set -e
echo "deploy.sh $*" >> ${JSON.stringify(calls)}
echo "pod agent-infra-api-1 10.0.1.2 cn-hangzhou.10.0.1.219"
if [[ "$2" == gate ]]; then
  printf '%s' '${JSON.stringify({ kind: "agent-infra-deploy-gate", approvalReasons: gateReasons, rolls: ["api"], activeExecutions: 0, migrations: { platform: { pending: 0, databaseAhead: false }, directory: { pending: 0, databaseAhead: false } } })}' > "$4"
fi
if [[ "$2" == diff || "$2" == deploy ]]; then
  printf '%s' '${JSON.stringify(imageCheck(missingImage))}' > "$AGENT_INFRA_IMAGE_CHECK_OUTPUT"
  ${missingImage ? 'echo "missing: registry.internal.invalid/team/agent-infra/agent-runtime-codex"; exit 2' : ":"}
fi
if [[ "$2" == deploy ]]; then test ! -L "$(dirname "$0")/.secrets/prod/config/api/key" || exit 7; cp "$AGENT_INFRA_RELEASE_FILE" ${JSON.stringify(join(root, "applied-release.json"))}; fi
if [[ "$2" == diff ]]; then echo "agent-infra, agent-infra-api, Deployment (apps) has changed:"; fi
if [[ "$2" == accept ]]; then
  test "$3" = "--task-api" && test -s "$AGENT_INFRA_TASK_ACCEPTANCE_FILE" || exit 9
  if [[ -n "\${SIGNAL_TEST_MARKER:-}" ]]; then
    exec node -e 'const fs=require("node:fs"),p=process.env.SIGNAL_TEST_MARKER; process.on("SIGINT",()=>{fs.writeFileSync(p+".received","cleaned");process.exit(1)}); fs.writeFileSync(p,"ready");setInterval(()=>{},1000)'
  fi
  [[ -d "$AGENT_INFRA_SOURCE_WORKTREE" ]] || exit 2
  test "$AGENT_INFRA_ACCEPTANCE_REVISION" = "112"
  node -e 'const f=require("node:fs"),r=JSON.parse(f.readFileSync(process.env.AGENT_INFRA_RELEASE_FILE)); const template={passed:true,persistedReply:true,releaseImage:true,modelCompleted:true,otherDenied:true};
    f.writeFileSync(process.argv[1],JSON.stringify({kind:"agent-infra-hosted-task-accept",version:r.version??null,sourceSha:r.source.sha,revision:${acceptRevision},
    run:"42",attempt:"1",passed:true,principalsActive:true,distinctPrincipals:true,oidcReceiptSha256:"a".repeat(64),templates:Object.fromEntries(["codex","claude","opencode","pi"].map(id=>[id,template]))}));' ${JSON.stringify(join(root, "accept-receipt.json"))}
  echo 'receipt: ${join(root, "accept-receipt.json")}'
  exit ${acceptExit}
fi
`,
	);
	chmodSync(join(fixture, "agent-infra", "deploy.sh"), 0o755);
	const secret = {
		data: Object.fromEntries(
			Object.entries({
				"helm-repository": "ssh://git@deploy.invalid/ai/helm.git",
				"helm-deploy-key": "KEY",
				"known-hosts": "deploy.invalid ssh-ed25519 AAAA",
				...(acceptance
					? {
							"acceptance.json": JSON.stringify({
								owner: {},
								other: {},
								relayKey: "fixture",
								...(acceptance === "legacy"
									? {}
									: { taskApi: { owner: "fixture-a", other: "fixture-b" } }),
							}),
						}
					: {}),
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
  *"get secret production-secret-baseline"*) if [[ -f ${JSON.stringify(clusterBaseline)} ]]; then cat ${JSON.stringify(clusterBaseline)}; fi ;;
  *"--field-manager=secret-baseline"*) cat > ${JSON.stringify(clusterBaseline)}
    if [[ "\${FAIL_BASELINE_WRITE:-}" == 1 ]]; then echo "test-only-baseline-marker" >&2; exit 1; fi
    if [[ "\${CORRUPT_BASELINE_READBACK:-}" == 1 ]]; then node -e 'const fs=require("node:fs"), f=process.argv[1], s=JSON.parse(fs.readFileSync(f)); s.data["files.json"]=Buffer.from("{}").toString("base64"); fs.writeFileSync(f,JSON.stringify(s));' ${JSON.stringify(clusterBaseline)}; fi ;;

  *"get secret production-deployer"*) printf '%s' '${JSON.stringify(secret)}' ;;
  *"get secrets -l"*) printf '{"items":[]}' ;;
  *"get imagecaches"*) printf '%s' '{"items":[{"status":{"phase":"Ready"}},{"status":{"phase":"Creating"}},{}]}' ;;
  *apply*) cat > ${JSON.stringify(join(root, "log-secret.json"))} ;;
esac`,
	);
	stub(
		"helm",
		`if [[ "$1" == "list" ]]; then printf '%s' '${JSON.stringify(installed ? [{ name: "agent-infra" }] : [])}'; exit 0; fi
if [[ "$1" == "history" && ( "${historyReadable}" == "false" || "${installed}" == "false" ) ]]; then exit 1; fi
if [[ "$1" == history && -f ${JSON.stringify(join(root, "accept-receipt.json"))} && "${postAcceptRevision ?? ""}" != "" ]]; then printf '%s' '${JSON.stringify([{ revision: postAcceptRevision, status: "deployed" }])}'; exit 0; fi
if [[ "$1 $2" == "get values" && -f ${JSON.stringify(join(root, "applied-release.json"))} ]]; then node -e 'console.log(JSON.stringify({deploymentRelease:require(process.argv[1])}))' ${JSON.stringify(join(root, "applied-release.json"))}; exit 0; fi
if [[ "$1 $2" == "get values" ]]; then printf '%s' '${JSON.stringify({ ...(legacy ? {} : { deploymentRelease: current }), images: { web: ref(manifests["platform-amd64"].images.web), api: staleApi ? `ghcr.io/agoraio-extensions/agent-infra/platform-api@sha256:${"0".repeat(64)}` : ref(manifests["platform-amd64"].images.platformApi), worker: ref(manifests["platform-amd64"].images.platformWorker), directory: ref(manifests["platform-amd64"].images.enterpriseDirectorySync), runtimeHost: manifests["runtime-host"].images.runtimeHost }, imageCaches: { images: [...Object.values(manifests["templates-amd64"].images).map(ref), ref(manifests["platform-amd64"].images.platformApi)] } })}'; else printf '%s' '${JSON.stringify([{ revision: 112, status: "deployed", updated: "2026-11-25T11:09:19+08:00" }, ...(!settled ? [{ revision: 113, status: "failed" }] : [])])}'; fi`,
	);
	const toolCalls = join(root, "tool-calls");
	writeFileSync(toolCalls, "");
	stub(
		"pnpm",
		`
echo "pnpm $*" >> ${JSON.stringify(toolCalls)}
if [[ "$*" == *"@agent-infra/web..."* ]]; then exit 19; fi
`,
	);
	const rows = Object.values(manifests).flatMap((m) => Object.values(m.images));
	rows.push({
		repository: "ghcr.io/agoraio-extensions/agent-infra/custom-agent-base",
		digest: `sha256:${"0".repeat(64)}`,
	});
	const indexes = rows.map((image) => ({
		commitSha: sourceSha,
		reference: `${image.repository}:v1.2.3`,
		digest: `sha256:${"a".repeat(64)}`,
		indexDigest: `sha256:${"a".repeat(64)}`,
		platformDigests: { "linux/amd64": image.digest },
	}));
	if (promotionTag)
		indexes.push({
			...indexes[0],
			sourceTag: promotionTag,
			reference: indexes[0].reference.replace(":v1.2.3", ":latest"),
		});
	for (const stem of ["published-indexes", "published-platform-indexes"])
		writeFileSync(
			join(fixture, `${stem}.jsonl`),
			indexes
				.filter((r) =>
					stem === "published-indexes"
						? /agent-runtime-|custom-agent-base/u.test(r.reference)
						: !/agent-runtime-|custom-agent-base/u.test(r.reference),
				)
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
	stub(
		"gh",
		`case "$*" in
*"run download"*) mkdir -p "\${@: -1}"; cp ${JSON.stringify(fixture)}/*.jsonl "\${@: -1}/" ;;
*"/artifacts"*) printf '%s' '${JSON.stringify([{ artifacts: ["published-indexes", "published-platform-indexes"].map((stem) => ({ name: `${stem}-${sourceSha}-1`, expired: false, size_in_bytes: 1000 })) }])}' ;;
*"git/commits/"*) printf '%s' '{"sha":"${sourceSha}","tree":{"sha":"${sourceSha}"},"verification":{"verified":false}}' ;;
*"git/ref/tags/"*) printf '%s' '{"object":{"type":"commit","sha":"${sourceSha}"}}' ;;
*"compare/"*) printf '%s' '{"status":"ahead"}' ;;
*"workflows/publish-images.yml/runs"*) printf '%s' '${JSON.stringify([{ workflow_runs: publication ? [publicationRun()] : [] }])}' ;;
*) exit 1 ;;
esac`,
	);
	stub(
		"git",
		`case "$1" in
  rev-parse) echo ${sourceSha} ;;
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
		PLANNED_RELEASE: createHash("sha256")
			.update(JSON.stringify({ revision: 112, release: current }))
			.digest("hex"),
		...extra,
	});
	return {
		env,
		baseline,
		clusterBaseline,
		run: (phase, extra) =>
			spawnSync(process.execPath, [deployScript, phase], { env: env(extra) })
				.status,
		calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
		toolCalls: () => readFileSync(toolCalls, "utf8"),
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
	assert.equal(existsSync(h.clusterBaseline), false);
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

test("an approved deploy reports failing business acceptance after verify when credentials are missing", (t) => {
	const h = harness();
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
		["gate", "diff", "deploy", "verify"],
	);
	assert.equal(h.receipt().accept.passed, false);
	assert.match(h.receipt().error, /DEPLOY_ACCEPT_INPUT_REQUIRED/u);
});

test("private standard template admission prepares its selected-source dependencies before the plan gate", (t) => {
	const h = harness({ standardTemplateRegistry: true });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 0);
	assert.match(
		h.toolCalls(),
		/pnpm install .*--filter @agent-infra\/image-registry\.\.\./u,
	);
	assert.match(
		h.toolCalls(),
		/pnpm .*--filter @agent-infra\/image-registry\.\.\. run build/u,
	);
});

test("the workflow entry forwards a runner cancellation to the private accept process", async (t) => {
	const h = harness({ acceptance: true });
	t.after(h.cleanup);
	const marker = join(h.env().RUNNER_TEMP, "signal");
	const child = spawn(
		"bash",
		["-c", 'exec "$1" "$2" plan', "step", process.execPath, deployScript],
		{
			env: h.env({ DEPLOY_COMMAND: "accept", SIGNAL_TEST_MARKER: marker }),
			stdio: "ignore",
		},
	);
	t.after(() => child.kill());
	const exit = once(child, "exit");
	for (
		let i = 0;
		!existsSync(marker) && i < 300 && child.exitCode === null;
		i++
	)
		await delay(100);
	assert.ok(existsSync(marker));
	child.kill("SIGINT");
	assert.equal((await exit)[0], 1);
	assert.equal(readFileSync(marker + ".received", "utf8"), "cleaned");
	assert.equal(h.receipt().accept.passed, false);
});

test("a nonzero accept command overrides a passing business receipt", (t) => {
	const h = harness({ acceptance: true, acceptExit: 1 });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "accept" }), 1);
	assert.equal(h.receipt().accept.passed, false);
	assert.match(h.receipt().error, /DEPLOY_ACCEPT_FAILED/u);
});

for (const command of ["accept", "deploy"]) {
	test(`${command} uses the public Task API against the deployed release without a browser`, (t) => {
		const h = harness({ acceptance: true, standardTemplateRegistry: true });
		t.after(h.cleanup);
		assert.equal(
			h.run(command === "accept" ? "plan" : "apply", {
				DEPLOY_COMMAND: command,
				PLANNED_HELM_COMMIT: helmSha,
				APPROVAL_RESULT: "skipped",
			}),
			0,
		);
		assert.equal(h.receipt().sourceSha, sourceSha);
		assert.deepEqual(h.receipt().accept, {
			passed: true,
			templates: { codex: true, claude: true, opencode: true, pi: true },
			revision: 112,
			oidcReceiptSha256: "a".repeat(64),
		});
		assert.doesNotMatch(h.toolCalls(), /@agent-infra\/web/u);
		if (command === "accept") assert.doesNotMatch(h.toolCalls(), /\bpnpm\b/u);
	});
}

test("legacy browser-only input stops before the first Task", (t) => {
	const h = harness({
		acceptance: "legacy",
		liveVersion: "v0.1.4",
		standardTemplateRegistry: true,
	});
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "accept" }), 1);
	assert.deepEqual(h.calls(), []);
	assert.doesNotMatch(h.toolCalls(), /\bpnpm\b/u);
	assert.equal(h.receipt().accept.passed, false);
	assert.match(h.receipt().error, /DEPLOY_ACCEPT_INPUT_REQUIRED/u);
});

test("a stale private receipt and a revision changed during the journey fail closed", (t) => {
	for (const options of [
		{ acceptRevision: 111 },
		{ postAcceptRevision: 113 },
	]) {
		const h = harness({ acceptance: true, liveVersion: "v0.1.4", ...options });
		t.after(h.cleanup);
		assert.equal(h.run("plan", { DEPLOY_COMMAND: "accept" }), 1);
		assert.equal(h.receipt().accept.passed, false);
	}
});

test("unreadable gate inputs need approval even when the gate lists no reason", () => {
	const ok = {
		platform: { pending: 0, databaseAhead: false },
		directory: { pending: 0, databaseAhead: false },
	};
	assert.deepEqual(
		failClosedReasons([], {
			rolls: ["api"],
			activeExecutions: 0,
			migrations: ok,
		}),
		[],
	);
	assert.deepEqual(
		failClosedReasons([], {
			rolls: ["api"],
			activeExecutions: null,
			migrations: ok,
		}),
		["active-executions-unreadable"],
	);
	assert.deepEqual(
		failClosedReasons([], {
			rolls: [],
			activeExecutions: null,
			migrations: ok,
		}),
		[],
	);
	assert.deepEqual(
		failClosedReasons([], {
			rolls: [],
			activeExecutions: 0,
			migrations: { ...ok, directory: { unreadable: true } },
		}),
		["migrations-unreadable"],
	);
	assert.deepEqual(
		failClosedReasons(["migrations-unreadable"], {
			rolls: [],
			activeExecutions: 0,
			migrations: {},
		}),
		["migrations-unreadable"],
	);
});

test("#4506 deploy plan records the internal registry check without the registry host", (t) => {
	const h = harness();
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 0);
	const receipt = h.receipt();
	assert.deepEqual(receipt.images.counts, { present: 2 });
	assert.equal(receipt.images.passed, true);
	assert.deepEqual(
		receipt.images.images.map((image) => image.name),
		["platform-api", "agent-runtime-codex"],
	);
	assert.match(
		h.summary(),
		/Internal registry \| passed: 2 digests \(2 present\)/u,
	);
	for (const text of [JSON.stringify(receipt), h.summary()])
		assert.doesNotMatch(text, /registry\.internal\.invalid/u);
});

test("#4506 a digest missing from the internal registry fails plan and apply before the cluster is written", (t) => {
	const h = harness({ missingImage: true });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 1);
	assert.equal(h.receipt().images.passed, false);
	assert.match(h.summary(), /missing agent-runtime-codex@sha256:2{64}/u);
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
		["gate", "diff", "gate", "diff"],
	);
	assert.match(h.receipt().error, /DEPLOY_STEP_FAILED: diff failed/u);
	assert.equal(existsSync(h.clusterBaseline), false);
	assert.equal(h.receipt().imageCaches, undefined);
});

test("#4506 an applied deploy reports ImageCache phases without waiting for Ready", (t) => {
	const h = harness({ acceptance: true });
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
	assert.deepEqual(h.receipt().imageCaches, {
		total: 3,
		phases: { Ready: 1, Creating: 1, Pending: 1 },
	});
	assert.match(
		h.summary(),
		/ImageCache \| 3 \(1 Ready, 1 Creating, 1 Pending\)/u,
	);
});

test("#4506 registry check output is reduced to public fields", () => {
	const summary = imageSummary({
		kind: "agent-infra-image-registry-check",
		prefix: internalPrefix,
		passed: true,
		images: [
			{
				repository: "ghcr.io/other/web",
				digest: `sha256:${"3".repeat(64)}`,
				status: "foreign",
			},
			{
				repository: `${internalPrefix}/web`,
				digest: "latest",
				status: "present\nInjected",
			},
		],
	});
	assert.equal(summary.passed, false);
	assert.deepEqual(summary.images, [
		{
			name: "(outside the pull prefix)",
			digest: `sha256:${"3".repeat(64)}`,
			status: "foreign",
		},
		{ name: "web", digest: "invalid", status: "error" },
	]);
	assert.throws(
		() => imageSummary({ kind: "other" }),
		/DEPLOY_IMAGE_CHECK_INVALID/u,
	);
	assert.deepEqual(imageCacheSummary({}), { unreadable: true });
});

test("#4506 a present entry with an invalid digest or a repository outside the pull prefix fails closed", () => {
	const check = (entry) =>
		imageSummary({
			kind: "agent-infra-image-registry-check",
			prefix: internalPrefix,
			passed: true,
			images: [
				{
					repository: `${internalPrefix}/platform-api`,
					digest: `sha256:${"1".repeat(64)}`,
					status: "present",
				},
				{ ...entry, status: "present" },
			],
		});
	const invalidDigest = check({
		repository: `${internalPrefix}/web`,
		digest: "sha256:short",
	});
	assert.equal(invalidDigest.passed, false);
	assert.equal(invalidDigest.images[1].digest, "invalid");
	const outside = check({
		repository: "ghcr.io/agoraio-extensions/agent-infra/web",
		digest: `sha256:${"4".repeat(64)}`,
	});
	assert.equal(outside.passed, false);
	assert.equal(outside.images[1].name, "(outside the pull prefix)");
});

const ref = (image) => `${image.repository}@${image.digest}`;
function releaseManifests() {
	const image = (name, n) => ({
		repository: `ghcr.io/agoraio-extensions/agent-infra/${name}`,
		digest: `sha256:${String(n).repeat(64)}`,
	});
	const manifest = (images) => ({
		schemaVersion: 1,
		commitSha: sourceSha,
		platform: "linux/amd64",
		images,
	});
	return {
		"platform-amd64": manifest({
			web: image("web", 1),
			platformApi: image("platform-api", 2),
			platformWorker: image("platform-worker", 3),
			enterpriseDirectorySync: image("enterprise-directory-sync", 4),
		}),
		"runtime-host": manifest({ runtimeHost: image("agent-runtime-host", 5) }),
		"templates-amd64": manifest({
			codex: image("agent-runtime-codex", 6),
			claude: image("agent-runtime-claude", 7),
			opencode: image("agent-runtime-opencode", 8),
			pi: image("agent-runtime-pi", 9),
		}),
	};
}
function publicationRun() {
	return {
		id: 123,
		run_attempt: 1,
		status: "completed",
		conclusion: "success",
		repository: { full_name: "AgoraIO-Extensions/agent-infra" },
		head_repository: { full_name: "AgoraIO-Extensions/agent-infra" },
		path: ".github/workflows/publish-images.yml",
		head_branch: "v1.2.3",
		head_sha: sourceSha,
		event: "push",
		display_title: `push | publish-images | v1.2.3 | ${sourceSha}`,
	};
}

test("an unpublished tag is refused before any deployment entry runs", (t) => {
	const h = harness({ publication: false });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		1,
	);
	assert.deepEqual(h.calls(), []);
	assert.match(h.receipt().error, /DEPLOY_VERSION_UNPUBLISHED/u);
});

test("a published tag selects its source and rejects a missing Harbor digest before writing", (t) => {
	const h = harness({ missingImage: true });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		1,
	);
	assert.equal(h.receipt().version, "v1.2.3");
	assert.equal(h.receipt().sourceSha, sourceSha);
	assert.equal(h.receipt().images.passed, false);
	assert.deepEqual(
		h.calls().map((c) => c.split(" ")[2]),
		["gate", "diff"],
	);
});

test("empty version retains the deployed release even when the environment lane pins another source", (t) => {
	const h = harness({ liveVersion: "v1.2.2" });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 0);
	assert.equal(h.receipt().version, "v1.2.2");
	assert.equal(h.receipt().sourceSha, sourceSha);
});

test("a failed newer attempt is refused without inferring the production version from it", (t) => {
	const h = harness({ settled: false });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 1);
	assert.match(h.receipt().error, /DEPLOY_RELEASE_NOT_SETTLED/u);
	assert.deepEqual(h.calls(), []);
});

test("a published tag plan binds apply to the same release and records tag and revision", (t) => {
	const h = harness({ acceptance: true });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		0,
	);
	const identity = h.output().match(/^release_identity=([a-f0-9]{64})$/mu)[1];
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "deploy",
			DEPLOY_VERSION: "v1.2.3",
			PLANNED_RELEASE: identity,
			PLANNED_HELM_COMMIT: helmSha,
			APPROVAL_RESULT: "skipped",
		}),
		0,
	);
	assert.equal(h.receipt().version, "v1.2.3");
	assert.equal(h.receipt().revisionAfter, 112);
	assert.deepEqual(h.receipt().publication, { runId: 123, attempt: 1 });
});

test("apply refuses a changed production revision or publication after plan", (t) => {
	const h = harness();
	t.after(h.cleanup);
	assert.equal(
		h.run("apply", {
			DEPLOY_COMMAND: "deploy",
			PLANNED_RELEASE: "0".repeat(64),
			PLANNED_HELM_COMMIT: helmSha,
			APPROVAL_RESULT: "success",
		}),
		1,
	);
	assert.match(h.receipt().error, /DEPLOY_RELEASE_MOVED/u);
	assert.deepEqual(h.calls(), []);
});

test("legacy empty version rejects a candidate API digest present only in a cache", (t) => {
	const h = harness({ staleApi: true, legacy: true });
	t.after(h.cleanup);
	assert.equal(h.run("plan", { DEPLOY_COMMAND: "deploy" }), 1);
	assert.match(h.receipt().error, /DEPLOY_CURRENT_RELEASE_UNKNOWN/u);
	assert.deepEqual(h.calls(), []);
});

test("unreadable production history never admits a tag deployment as a fresh install", (t) => {
	const h = harness({ historyReadable: false });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		1,
	);
	assert.match(h.receipt().error, /DEPLOY_RELEASE_NOT_SETTLED/u);
	assert.deepEqual(h.calls(), []);
});

test("an explicitly published tag admits a first install only after a successful empty release inventory", (t) => {
	const h = harness({ installed: false, gateReasons: ["migrations-pending"] });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		0,
	);
	assert.equal(h.receipt().version, "v1.2.3");
	assert.deepEqual(h.receipt().approval, {
		required: true,
		reasons: ["migrations-pending"],
	});
});

test("the new executor refuses a private main that still uses pinned versions and its private chart", (t) => {
	const h = harness({ contract: false });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		1,
	);
	assert.match(h.receipt().error, /DEPLOY_ENVIRONMENT_CONTRACT_REQUIRED/u);
	assert.deepEqual(h.calls(), []);
});

test("a publication promotion from another tag is refused before deployment planning", (t) => {
	const h = harness({ promotionTag: "v1.2.2" });
	t.after(h.cleanup);
	assert.equal(
		h.run("plan", { DEPLOY_COMMAND: "deploy", DEPLOY_VERSION: "v1.2.3" }),
		1,
	);
	assert.match(h.receipt().error, /DEPLOY_VERSION_INVALID/u);
	assert.deepEqual(h.calls(), []);
});

test("hosted acceptance requires four release-bound journeys from distinct principals", () => {
	const expected = {
		version: "v0.1.4",
		sourceSha,
		revision: 135,
		run: "42",
		attempt: "1",
	};
	const entry = {
		passed: true,
		persistedReply: true,
		modelCompleted: true,
		releaseImage: true,
		otherDenied: true,
	};
	const templates = Object.fromEntries(
		["codex", "claude", "opencode", "pi"].map((id) => [id, entry]),
	);
	const receipt = {
		...expected,
		kind: "agent-infra-hosted-task-accept",
		passed: true,
		distinctPrincipals: true,
		principalsActive: true,
		oidcReceiptSha256: "a".repeat(64),
		templates,
	};
	assert.equal(acceptOutcome(receipt, expected).passed, true);
	for (const patch of [
		{ version: "v0.1.3" },
		{ revision: 134 },
		{ run: "41" },
		{ attempt: "2" },
		{ sourceSha: otherSha },
		{ distinctPrincipals: false },
		{ principalsActive: false },
		{ templates: { ...templates, codex: { ...entry, modelCompleted: false } } },
		{ oidcReceiptSha256: "" },
		{ templates: { pi: entry } },
		{ templates: { ...templates, pi: { ...entry, otherDenied: false } } },
	]) {
		assert.equal(
			acceptOutcome({ ...receipt, ...patch }, expected).passed,
			false,
		);
	}
});

test("#4562 apply verifies exact cluster bytes and publishes only changed paths and digests", (t) => {
	const h = harness({ acceptance: true });
	t.after(h.cleanup);
	const apply = { DEPLOY_COMMAND: "deploy", PLANNED_HELM_COMMIT: helmSha };
	assert.equal(h.run("plan", apply), 0);
	assert.equal(existsSync(h.clusterBaseline), false);
	assert.equal(h.run("apply", apply), 0);
	const digest = createHash("sha256").update(syntheticSecret).digest("hex");
	assert.deepEqual(h.receipt().secretBaseline, {
		updated: [
			{ path: "config/api/key", sha256: digest },
			{ path: "material/key", sha256: digest },
		],
		removed: [],
	});
	const secret = JSON.parse(readFileSync(h.clusterBaseline));
	const files = JSON.parse(
		Buffer.from(secret.data["files.json"], "base64").toString("utf8"),
	);
	assert.deepEqual(files, {
		"config/api/key": syntheticSecret.toString("base64"),
		"material/key": syntheticSecret.toString("base64"),
	});
	assert.match(h.summary(), new RegExp(digest));
	for (const output of [
		h.summary(),
		JSON.stringify(h.receipt()),
		h.output(),
		gunzipSync(
			Buffer.from(h.logSecret().data["output.log.gz"], "base64"),
		).toString("utf8"),
	]) {
		assert.doesNotMatch(output, /test-only-baseline-marker/u);
		assert.equal(output.includes(syntheticSecret.toString("base64")), false);
	}
});

test("#4562 a changed or removed file is reported once and unchanged files survive a retry", (t) => {
	const h = harness({ acceptance: true });
	t.after(h.cleanup);
	const files = {
		"config/api/key": syntheticSecret.toString("base64"),
		"material/key": "b2xk",
		"external/old": "b2xk",
	};
	const secret = {
		data: {
			"files.json": Buffer.from(JSON.stringify(files)).toString("base64"),
		},
		metadata: { resourceVersion: "7" },
	};
	writeFileSync(h.clusterBaseline, JSON.stringify(secret));
	const apply = { DEPLOY_COMMAND: "deploy", PLANNED_HELM_COMMIT: helmSha };
	assert.equal(h.run("apply", apply), 0);
	assert.deepEqual(h.receipt().secretBaseline, {
		updated: [
			{
				path: "material/key",
				sha256: createHash("sha256").update(syntheticSecret).digest("hex"),
			},
		],
		removed: [
			{
				path: "external/old",
				sha256: createHash("sha256").update("old").digest("hex"),
			},
		],
	});
	const prior = readFileSync(h.clusterBaseline, "utf8");
	assert.equal(JSON.parse(prior).metadata.resourceVersion, "7");
	rmSync(join(h.env().RUNNER_TEMP, "deploy-executor"), { recursive: true });
	assert.equal(h.run("apply", { ...apply, FAIL_BASELINE_WRITE: "1" }), 0);
	assert.deepEqual(h.receipt().secretBaseline, { updated: [], removed: [] });
	assert.equal(readFileSync(h.clusterBaseline, "utf8"), prior);
});

for (const option of ["FAIL_BASELINE_WRITE", "CORRUPT_BASELINE_READBACK"]) {
	test(`#4562 ${option} stops before deployment and keeps command diagnostics private`, (t) => {
		const h = harness();
		t.after(h.cleanup);
		const env = {
			DEPLOY_COMMAND: "deploy",
			PLANNED_HELM_COMMIT: helmSha,
			[option]: "1",
		};
		const result = spawnSync(process.execPath, [deployScript, "apply"], {
			env: h.env(env),
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.equal(h.calls().includes("deploy.sh prod deploy"), false);
		assert.equal(h.receipt().secretBaseline, undefined);
		for (const output of [
			result.stdout,
			result.stderr,
			h.summary(),
			h.output(),
			JSON.stringify(h.receipt()),
			gunzipSync(
				Buffer.from(h.logSecret().data["output.log.gz"], "base64"),
			).toString("utf8"),
		]) {
			assert.doesNotMatch(output, /test-only-baseline-marker/u);
		}
	});
}

test("#4562 a link outside the environment or an oversized baseline fails before Secret publication", (t) => {
	const h = harness();
	t.after(h.cleanup);
	const link = join(h.baseline, "external-link");
	symlinkSync("../../releases/platform-amd64.json", link);
	const opts = { DEPLOY_COMMAND: "deploy", PLANNED_HELM_COMMIT: helmSha };
	assert.equal(h.run("apply", opts), 1);
	assert.equal(existsSync(h.clusterBaseline), false);
	rmSync(link);
	rmSync(join(h.env().RUNNER_TEMP, "deploy-executor"), { recursive: true });
	writeFileSync(join(h.baseline, "too-large"), Buffer.alloc(1024 * 1024));
	assert.equal(h.run("apply", opts), 1);
	assert.equal(existsSync(h.clusterBaseline), false);
});
