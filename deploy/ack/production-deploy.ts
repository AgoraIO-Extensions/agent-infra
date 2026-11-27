import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planFromPublication, validatePublicationRun } from "../release/image-mirror.ts";

// In-cluster deploy executor of the production lane (workflow Spec §10.3). It runs the Helm
// deployment repository's own entry (`agent-infra/deploy.sh prod <command>`) on an ephemeral ACK
// runner. The job authenticates to the API server with its GitHub OIDC token and reads the
// deployment repository key and acceptance accounts from a cluster Secret; nothing comes from
// GitHub Secrets. Deploy planning reads the release. Standalone acceptance exercises its designated test Agents.
//
// Workflow logs, the Summary and artifacts of this public repository are public. Command output
// (manifests, diffs, Pod and node addresses, internal hosts) therefore goes to a log Secret in the
// deployer namespace; GitHub only gets the receipt: commits, revisions, counts and pass/fail.
//
//   node deploy/ack/production-deploy.ts <plan|apply>

export const commands = ["status", "diff", "deploy", "verify", "accept", "rollback"] as const;
export type Command = (typeof commands)[number];
export type Phase = "plan" | "apply";
export type Inputs = { command: Command; helmCommit?: string; revision?: number; version?: string };
export type Step = { name: string; exitCode: number; seconds: number };
export type MigrationState = { pending: number; databaseAhead: boolean } | { unreadable: true };
export type ImageCheck = {
	passed: boolean;
	checked: number;
	counts: Record<string, number>;
	// Repository names relative to the pull prefix: the registry host stays out of the public receipt.
	images: Array<{ name: string; digest: string; status: string }>;
};
export type ImageCaches = { total: number; phases: Record<string, number> } | { unreadable: true };
type AcceptanceBinding = { version: string | null; sourceSha: string; revision: number; run: string; attempt: string };
type AcceptanceResult = { passed: boolean; templates: Record<string, boolean>; revision?: number; oidcReceiptSha256?: string };
export type Receipt = {
	schemaVersion: 1;
	kind: "agent-infra-production-deploy";
	phase: Phase;
	command?: Command;
	run?: { id: string; attempt: string };
	helmCommit?: string;
	sourceSha?: string;
	version?: string;
	publication?: { runId: number; attempt: number };
	revisionBefore?: number;
	revisionAfter?: number;
	history?: Array<{ revision: number; status: string; updated: string }>;
	changes?: string[];
	approval?: { required: boolean; reasons: string[]; approved?: boolean };
	gate?: { rolls: string[]; activeExecutions: number | null; migrations: Record<string, MigrationState> };
	accept?: AcceptanceResult;
	images?: ImageCheck;
	imageCaches?: ImageCaches;
	log?: string;
	steps: Step[];
	passed?: boolean;
	error?: string;
};

const repository = "https://github.com/AgoraIO-Extensions/agent-infra";
const secretNamespace = "agent-infra-deployer";
const secretName = "production-deployer";
// Mounted from the kube-root-ca.crt ConfigMap by the runner Pod template.
const caFile = "/etc/agent-infra/kube-ca/ca.crt";
const apiServer = "https://kubernetes.default.svc";
const sha40 = /^[0-9a-f]{40}$/u;
const keptLogs = 30;

export class DeployError extends Error {
	readonly code: string;
	constructor(code: string, detail: string) {
		super(`${code}: ${detail}`);
		this.code = code;
	}
}

/** Workflow inputs arrive as untrusted strings; anything unexpected stops before the cluster is touched. */
export function parseInputs(env: Record<string, string | undefined>): Inputs {
	const command = env.DEPLOY_COMMAND ?? "";
	if (!(commands as readonly string[]).includes(command)) throw new DeployError("DEPLOY_INPUT_INVALID", "unknown command");
	const helmCommit = env.DEPLOY_HELM_COMMIT ?? "";
	if (helmCommit !== "" && !sha40.test(helmCommit)) throw new DeployError("DEPLOY_INPUT_INVALID", "helm_commit must be a full lowercase 40-hex commit");
	const revision = env.DEPLOY_REVISION ?? "";
	const version = env.DEPLOY_VERSION ?? "";
	if (version && (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || !["diff", "deploy"].includes(command)))
		throw new DeployError("DEPLOY_INPUT_INVALID", "version must be vX.Y.Z and is only for diff or deploy");
	if (command === "rollback" && !/^[1-9]\d{0,8}$/u.test(revision))
		throw new DeployError("DEPLOY_INPUT_INVALID", "rollback needs revision, a positive Helm revision number");
	if (command !== "rollback" && revision !== "") throw new DeployError("DEPLOY_INPUT_INVALID", "revision is only for rollback");
	return {
		command: command as Command,
		...(helmCommit ? { helmCommit } : {}),
		...(version ? { version } : {}),
		...(command === "rollback" ? { revision: Number(revision) } : {}),
	};
}

/** Commands that write the cluster run again in the apply job, after the approval decision. */
export const writes = (command: Command) => command === "deploy" || command === "rollback";

/** Selected App source supplies migration journals and release verification packages. */
export function sourceNeeds(command: Command, phase: Phase, privateStandardTemplates = false): { checkout: boolean; build: boolean } {
	if (privateStandardTemplates && ["diff", "deploy", "verify"].includes(command)) return { checkout: true, build: true };
	if (command === "verify") return { checkout: true, build: true };
	if (command === "deploy") return { checkout: true, build: phase === "apply" };
	if (command === "accept") return { checkout: true, build: false };
	return { checkout: false, build: false };
}

export function planApproval(command: Command, gateReasons: string[] = []): { required: boolean; reasons: string[] } {
	const reasons = command === "rollback" ? ["rollback"] : command === "deploy" ? gateReasons : [];
	return { required: reasons.length > 0, reasons };
}

/** Why the apply job must not write, or undefined. Approval covers only the reasons it was asked for. */
export function admissionError(input: { command: Command; approved: boolean; plannedReasons: string[]; currentReasons: string[] }): string | undefined {
	if (input.command === "rollback") return input.approved ? undefined : "rollback needs approval in the production-approval Environment";
	if (input.currentReasons.length === 0) return undefined;
	if (!input.approved) return `approval needed (${input.currentReasons.join(", ")}) but the run was not approved`;
	const unapproved = input.currentReasons.filter((reason) => !input.plannedReasons.includes(reason));
	return unapproved.length ? `new approval reasons since the plan: ${unapproved.join(", ")}; start a new run` : undefined;
}

export function kubeconfig(audience: string, credentialScript: string, ca: string, node = process.execPath): string {
	return JSON.stringify({
		apiVersion: "v1",
		kind: "Config",
		clusters: [{ name: "ack", cluster: { server: apiServer, "certificate-authority": ca } }],
		users: [{
			name: "github-actions-oidc",
			user: { exec: { apiVersion: "client.authentication.k8s.io/v1", command: node, args: [credentialScript, audience], interactiveMode: "Never" } },
		}],
		contexts: [{ name: "ack", context: { cluster: "ack", user: "github-actions-oidc" } }],
		"current-context": "ack",
	});
}

/** Keeps only the gate's counts, object kinds and booleans. */
export function gateSummary(gate: unknown): { reasons: string[]; summary: NonNullable<Receipt["gate"]> } {
	const value = gate as { kind?: unknown; approvalReasons?: unknown; rolls?: unknown; activeExecutions?: unknown; migrations?: Record<string, unknown> } | null;
	const reasons = value?.approvalReasons;
	const rolls = value?.rolls;
	if (value?.kind !== "agent-infra-deploy-gate" || !Array.isArray(reasons) || !Array.isArray(rolls) ||
		![...reasons, ...rolls].every((item) => typeof item === "string" && /^[a-z-]{1,40}$/u.test(item)))
		throw new DeployError("DEPLOY_GATE_INVALID", "deploy gate output is not a gate receipt");
	const migrations = Object.fromEntries(Object.entries(value.migrations ?? {}).filter(([name]) => /^[a-z-]{1,40}$/u.test(name)).map(([name, state]) => {
		const entry = state as { pending?: unknown; databaseAhead?: unknown } | null;
		return [name, Number.isSafeInteger(entry?.pending) && typeof entry?.databaseAhead === "boolean"
			? { pending: entry.pending as number, databaseAhead: entry.databaseAhead }
			: { unreadable: true as const }];
	}));
	const active = value.activeExecutions;
	return {
		reasons: reasons as string[],
		summary: { rolls: rolls as string[], activeExecutions: Number.isSafeInteger(active) ? (active as number) : null, migrations },
	};
}

/** Adds the unreadable-input reasons even if the gate omitted them: an unread check never passes. */
export function failClosedReasons(reasons: string[], gate: NonNullable<Receipt["gate"]>): string[] {
	const result = new Set(reasons);
	const migrations = Object.values(gate.migrations);
	if (migrations.length === 0 || migrations.some((state) => "unreadable" in state)) result.add("migrations-unreadable");
	if (gate.rolls.length > 0 && gate.activeExecutions === null) result.add("active-executions-unreadable");
	return [...result];
}

/** Object headers of a helm-diff run, e.g. "agent-infra, agent-infra-api, Deployment (apps) has changed". */
export function diffChanges(output: string): string[] {
	return [...output.matchAll(/^([a-z0-9-]+), ([a-z0-9.-]+), ([A-Za-z]+) \(([a-z0-9.]*)\) (has changed|has been added|has been removed):$/gmu)]
		.map((match) => `${match[3]}/${match[2]} ${match[5].replace(/^has (been )?/u, "")}`)
		.slice(0, 100);
}

/** Project only contract-defined evidence into the public artifact. */
export function acceptOutcome(receipt: unknown, expected: AcceptanceBinding): AcceptanceResult {
	const value = receipt as (Partial<AcceptanceBinding> & {
		kind?: unknown; passed?: unknown; distinctPrincipals?: unknown; principalsActive?: unknown; oidcReceiptSha256?: unknown;
		templates?: Record<string, {passed?: unknown; modelCompleted?: unknown; otherDenied?: unknown; persistedReply?: unknown; releaseImage?: unknown}>;
	}) | null;
	const templates = Object.fromEntries(Object.keys(manifestKeys["templates-amd64"]!).map(id => {
		const result = value?.templates?.[id];
		return [id, result?.passed === true && result.persistedReply === true && result.modelCompleted === true && result.releaseImage === true && result.otherDenied === true];
	}));
	const hash = value?.oidcReceiptSha256;
	const bound = value?.kind === "agent-infra-hosted-task-accept" && value.version === expected.version &&
		value.sourceSha === expected.sourceSha && value.revision === expected.revision && value.run === expected.run && value.attempt === expected.attempt;
	const oidcReceiptSha256 = typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash) ? hash : undefined;
	return {
		passed: bound && !!oidcReceiptSha256 && value.passed === true && value.distinctPrincipals === true && value.principalsActive === true && Object.values(templates).every(Boolean),
		templates: bound ? templates : {}, revision: expected.revision, ...(bound && oidcReceiptSha256 ? {oidcReceiptSha256} : {}),
	};
}

export function historySummary(history: unknown): NonNullable<Receipt["history"]> {
	return (Array.isArray(history) ? history : []).map((entry) => ({
		revision: Number(entry?.revision),
		status: /^[a-z-]{1,30}$/u.test(String(entry?.status)) ? String(entry.status) : "unknown",
		updated: /^[\d\-T:.+ Z]{1,40}$/u.test(String(entry?.updated)) ? String(entry.updated) : "",
	})).filter((entry) => Number.isSafeInteger(entry.revision));
}

const outsidePrefix = "(outside the pull prefix)";

/** The deploy entry's registry check (helm repository scripts/image-registry.mjs), reduced to public fields. */
export function imageSummary(check: unknown): ImageCheck {
	const value = check as { kind?: unknown; prefix?: unknown; passed?: unknown; images?: unknown };
	if (value?.kind !== "agent-infra-image-registry-check" || typeof value.prefix !== "string" || !Array.isArray(value.images))
		throw new DeployError("DEPLOY_IMAGE_CHECK_INVALID", "the image registry check output is not readable");
	const prefix = `${value.prefix}/`;
	const digest = /^sha256:[a-f0-9]{64}$/u;
	const images = value.images.map((entry: { repository?: unknown; digest?: unknown; status?: unknown }) => {
		const repository = typeof entry?.repository === "string" ? entry.repository : "";
		const status = typeof entry?.status === "string" && /^[a-z]{1,16}$/u.test(entry.status) ? entry.status : "error";
		const name = repository.startsWith(prefix) && /^[a-z0-9._/-]{1,128}$/u.test(repository.slice(prefix.length)) ? repository.slice(prefix.length) : outsidePrefix;
		return { name, digest: typeof entry?.digest === "string" && digest.test(entry.digest) ? entry.digest : "invalid", status };
	});
	const counts: Record<string, number> = {};
	for (const image of images) counts[image.status] = (counts[image.status] ?? 0) + 1;
	// Fail closed: a present status does not pass an entry whose digest or repository did not validate.
	const passed = value.passed === true && images.every((image) => image.status === "present" && image.digest !== "invalid" && image.name !== outsidePrefix);
	return { passed, checked: images.length, counts, images };
}

/** ImageCache objects of the lane by status phase; creation does not wait for Ready. */
export function imageCacheSummary(list: unknown): ImageCaches {
	const items = (list as { items?: unknown })?.items;
	if (!Array.isArray(items)) return { unreadable: true };
	const phases: Record<string, number> = {};
	for (const item of items as Array<{ status?: { phase?: unknown } }>) {
		const phase = typeof item?.status?.phase === "string" && /^[A-Za-z]{1,32}$/u.test(item.status.phase) ? item.status.phase : "Pending";
		phases[phase] = (phases[phase] ?? 0) + 1;
	}
	return { total: items.length, phases };
}

export function summaryMarkdown(receipt: Receipt): string {
	const lines = [
		`## Production ${receipt.phase}: ${receipt.command ?? "unknown"} ${receipt.passed ? "passed" : "failed"}`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Helm deployment repository commit | ${receipt.helmCommit ?? "unknown"} |`,
		`| Version | ${receipt.version ?? (receipt.publication ? "current (legacy receipt)" : "unknown")} |`,
		`| App source SHA | ${receipt.sourceSha ?? "unknown"} |`,
		`| Helm revision | ${receipt.revisionBefore ?? "unknown"}${receipt.revisionAfter !== undefined ? ` → ${receipt.revisionAfter}` : ""} |`,
	];
	if (receipt.approval) {
		const decision = receipt.approval.required ? `required: ${receipt.approval.reasons.join(", ")}` : "not required";
		lines.push(`| Approval | ${decision}${receipt.approval.approved ? " (approved)" : ""} |`);
	}
	if (receipt.gate) {
		const migrations = Object.entries(receipt.gate.migrations)
			.map(([name, state]) => `${name} ${"unreadable" in state ? "unreadable" : `${state.pending} pending${state.databaseAhead ? ", database ahead" : ""}`}`);
		lines.push(`| Gate | rolls: ${receipt.gate.rolls.join(", ") || "none"}; in-flight executions: ${receipt.gate.activeExecutions ?? "unreadable"}; migrations: ${migrations.join("; ")} |`);
	}
	if (receipt.changes) lines.push(`| Changes | ${receipt.changes.join("<br>") || "none"} |`);
	if (receipt.images) {
		const counts = Object.entries(receipt.images.counts).map(([status, count]) => `${count} ${status}`).join(", ");
		const failed = receipt.images.images.filter((image) => image.status !== "present").map((image) => `${image.status} ${image.name}@${image.digest}`);
		lines.push(`| Internal registry | ${receipt.images.passed ? "passed" : "failed"}: ${receipt.images.checked} digests (${counts})${failed.length ? `<br>${failed.join("<br>")}` : ""} |`);
	}
	if (receipt.imageCaches) {
		const caches = "unreadable" in receipt.imageCaches ? "unreadable"
			: `${receipt.imageCaches.total} (${Object.entries(receipt.imageCaches.phases).map(([phase, count]) => `${count} ${phase}`).join(", ") || "none"})`;
		lines.push(`| ImageCache | ${caches} |`);
	}
	if (receipt.accept) {
		const accept = receipt.accept;
		const details = Object.entries(accept.templates).map(([id, ok]) => `${id} ${ok ? "ok" : "failed"}`).join(", ");
		lines.push(`| Accept | ${accept.passed ? "passed" : "failed"}${details ? ` (${details})` : ""} |`);
		if (accept.revision) lines.push(`| Accept revision | ${accept.revision} |`);
	}
	for (const entry of receipt.history ?? []) lines.push(`| Revision ${entry.revision} | ${entry.status} ${entry.updated} |`);
	for (const step of receipt.steps) lines.push(`| Step ${step.name} | exit ${step.exitCode}, ${step.seconds}s |`);
	if (receipt.command === "rollback" && receipt.phase === "apply" && receipt.passed)
		lines.push(`| Next | revert the deployment repository commits made after revision ${receipt.revisionAfter ?? "unknown"}, then run diff |`);
	if (receipt.log) lines.push(`| Command output | Secret ${secretNamespace}/${receipt.log} |`);
	if (receipt.error) lines.push(`| Error | ${receipt.error.replaceAll("|", "\\|")} |`);
	return `${lines.join("\n")}\n`;
}

type Context = {
	inputs: Inputs;
	phase: Phase;
	work: string;
	log: string;
	receipt: Receipt;
	env: NodeJS.ProcessEnv;
	helm: string;
	source: string;
	selectedRevision?: number;
	lane?: { release: string; namespace: string };
	helmRepository?: string;
};

/** Runs a command with its stderr in the private log; stdout is returned, never printed. */
function capture(context: Context, command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {}): string {
	appendFileSync(context.log, `\n$ ${command} ${args[0] ?? ""}\n`);
	const result = spawnSync(command, args, {
		env: options.env ?? context.env, cwd: options.cwd, input: options.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
		stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	appendFileSync(context.log, result.stderr ?? "");
	if (result.status !== 0) throw new DeployError("DEPLOY_COMMAND_FAILED", `${command} ${args[0] ?? ""} exited ${result.status ?? result.signal}`);
	return result.stdout;
}

/** Runs one deploy.sh command with all of its output in the private log. */
function openStep(context: Context, name: string, args: string[]) {
	const started = Date.now();
	const file = join(context.work, `step-${context.receipt.steps.length}.out`);
	const fd = openSync(file, "w", 0o600);
	console.log(`Running ${name}`);
	const finish = (exitCode: number) => {
		closeSync(fd);
		const output = readFileSync(file, "utf8");
		appendFileSync(context.log, `\n$ deploy.sh prod ${args.join(" ")}\n${output}`);
		const imageCheck = context.env.AGENT_INFRA_IMAGE_CHECK_OUTPUT;
		if (imageCheck && existsSync(imageCheck)) {
			context.receipt.images = imageSummary(JSON.parse(readFileSync(imageCheck, "utf8")));
			rmSync(imageCheck);
		}
		const seconds = Math.round((Date.now() - started) / 1000);
		context.receipt.steps.push({ name, exitCode, seconds });
		console.log(`${name}: exit ${exitCode} after ${seconds}s`);
		return { exitCode, output };
	};
	return {command: join(context.helm, "agent-infra", "deploy.sh"), args: ["prod", ...args],
		options: {env: context.env, cwd: context.helm, stdio: ["ignore", fd, fd] as ["ignore", number, number]}, finish};
}

function step(context: Context, name: string, args: string[]) {
	const job = openStep(context, name, args);
	const result = spawnSync(job.command, job.args, job.options);
	return job.finish(result.status ?? 1);
}

// The Actions runner signals the step entry PID. Forward cancellation to the
// private accept entry so it can cancel its own unfinished Task.
async function acceptanceStep(context: Context) {
	const job = openStep(context, "accept", ["accept", "--task-api"]);
	const child = spawn(job.command, job.args, job.options);
	let cancelled = false;
	const forward = (signal: NodeJS.Signals) => { cancelled = true; child.kill(signal); };
	const interrupt = () => forward("SIGINT");
	const terminate = () => forward("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	try {
		const code = await new Promise<number>((resolve) => {
			child.once("error", () => resolve(1));
			child.once("close", (status) => resolve(status ?? 1));
		});
		return job.finish(cancelled ? 1 : code);
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	}
}

function required(context: Context, name: string, args: string[]): string {
	const { exitCode, output } = step(context, name, args);
	if (exitCode !== 0) throw new DeployError("DEPLOY_STEP_FAILED", `${name} failed; see the command output Secret`);
	if ((name === "diff" || name === "deploy") && (!context.receipt.images?.passed || context.receipt.images.checked === 0))
		throw new DeployError("DEPLOY_IMAGE_CHECK_REQUIRED", "a successful internal registry check is required");
	return output;
}

function readHistory(context: Context, max: number): Receipt["history"] {
	try {
		if (!context.lane) return undefined;
		return historySummary(JSON.parse(capture(context, "helm", ["history", context.lane.release, "-n", context.lane.namespace, "--max", String(max), "-o", "json"])));
	} catch {
		return undefined;
	}
}

const currentRevision = (context: Context) => readHistory(context, 1)?.at(-1)?.revision;

type ReleaseManifest = { schemaVersion: 1; commitSha: string; platform: string; images: Record<string, { repository: string; digest: string }> };
type DeploymentRelease = { version?: string; source: { repository: string; sha: string; releaseRun: number; attempt: number }; manifests: Record<string, ReleaseManifest> };
const manifestKeys: Record<string, Record<string, string>> = {
	"platform-amd64": { web: "web", platformApi: "platform-api", platformWorker: "platform-worker", enterpriseDirectorySync: "enterprise-directory-sync" },
	"runtime-host": { runtimeHost: "agent-runtime-host" },
	"templates-amd64": { codex: "agent-runtime-codex", claude: "agent-runtime-claude", opencode: "agent-runtime-opencode", pi: "agent-runtime-pi" },
};

function validateDeploymentRelease(value: DeploymentRelease): DeploymentRelease {
	if (!value?.source || value.source.repository !== "AgoraIO-Extensions/agent-infra" || !sha40.test(value.source.sha) ||
		!Number.isSafeInteger(value.source.releaseRun) || value.source.releaseRun <= 0 || !Number.isSafeInteger(value.source.attempt) || value.source.attempt <= 0 ||
		(value.version !== undefined && !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.version)))
		throw new DeployError("DEPLOY_RELEASE_INVALID", "release provenance is missing or invalid");
	for (const [name, keys] of Object.entries(manifestKeys)) {
		const manifest = value.manifests?.[name];
		if (manifest?.schemaVersion !== 1 || manifest.commitSha !== value.source.sha || manifest.platform !== "linux/amd64" ||
			Object.entries(keys).some(([key, imageName]) => manifest.images?.[key]?.repository !== `ghcr.io/agoraio-extensions/agent-infra/${imageName}` || !/^sha256:[a-f0-9]{64}$/u.test(manifest.images[key]?.digest ?? "")))
			throw new DeployError("DEPLOY_RELEASE_INVALID", "release image receipts are incomplete or inconsistent");
	}
	return value;
}

/** Resolves only a successful tag publication; input code is never executed. */
function tagRelease(context: Context, version: string): DeploymentRelease {
	const api = (path: string, paginate = false) => JSON.parse(capture(context, "gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), `repos/AgoraIO-Extensions/agent-infra/${path}`]));
	let object = api(`git/ref/tags/${version}`).object;
	for (let depth = 0; object?.type === "tag" && depth < 5; depth++) object = api(`git/tags/${object.sha}`).object;
	if (object?.type !== "commit" || !sha40.test(object.sha)) throw new DeployError("DEPLOY_VERSION_INVALID", "tag does not resolve to a commit");
	const sourceSha = object.sha;
	const pages = api(`actions/workflows/publish-images.yml/runs?branch=${version}&event=push&status=success&per_page=100`, true);
	const runs = pages.flatMap((page: { workflow_runs: any[] }) => page.workflow_runs).filter((run: any) => run.head_sha === sourceSha && run.head_branch === version);
	if (!runs.length) throw new DeployError("DEPLOY_VERSION_UNPUBLISHED", "tag has no successful Publish images run");
	const run = runs[0];
	if (validatePublicationRun(run, String(run.id), String(run.run_attempt)) !== sourceSha)
		throw new DeployError("DEPLOY_VERSION_INVALID", "publication source does not match the tag");
	if (!["ahead", "identical"].includes(api(`compare/${sourceSha}...main`).status))
		throw new DeployError("DEPLOY_VERSION_INVALID", "tag source is not on main");
	const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`, true).flatMap((page: { artifacts: any[] }) => page.artifacts);
	const download = (stem: string) => {
		const name = `${stem}-${sourceSha}-${run.run_attempt}`;
		const matches = artifacts.filter((artifact: any) => artifact.name === name);
		if (matches.length !== 1 || matches[0].expired || matches[0].size_in_bytes <= 0 || matches[0].size_in_bytes > 1_000_000)
			throw new DeployError("DEPLOY_VERSION_UNPUBLISHED", "publication artifact missing, expired or invalid");
		const directory = join(context.work, name);
		capture(context, "gh", ["run", "download", String(run.id), "--repo", "AgoraIO-Extensions/agent-infra", "--name", name, "--dir", directory]);
		const file = join(directory, `${stem}.jsonl`);
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new DeployError("DEPLOY_VERSION_INVALID", "publication file is invalid");
		const text = readFileSync(file, "utf8");
		for (const row of text.trim().split("\n").map((line) => JSON.parse(line)))
			if (row.sourceTag ? row.sourceTag !== version : !String(row.reference).endsWith(`:${version}`)) throw new DeployError("DEPLOY_VERSION_INVALID", "artifact tag does not match version");
		return text;
	};
	const plan = planFromPublication(download("published-indexes"), download("published-platform-indexes"), sourceSha);
	if (plan.status !== "planned") throw new DeployError("DEPLOY_VERSION_UNPUBLISHED", "publication is not a full release");
	const manifests = Object.fromEntries(Object.entries(manifestKeys).map(([name, keys]) => [name, {
		schemaVersion: 1 as const, commitSha: sourceSha, platform: "linux/amd64",
		images: Object.fromEntries(Object.entries(keys).map(([key, imageName]) => {
			const image = plan.images.find((image) => image.name === imageName);
			if (!image) throw new DeployError("DEPLOY_VERSION_UNPUBLISHED", "publication is incomplete");
			return [key, { repository: image.source.split("@")[0] as string, digest: image.digest }];
		})),
	}]));
	return validateDeploymentRelease({ version, source: { repository: "AgoraIO-Extensions/agent-infra", sha: sourceSha, releaseRun: run.id, attempt: run.run_attempt }, manifests });
}

function prepareRelease(context: Context, lane: { release: string; namespace: string }): void {
	const command = context.inputs.command;

	const history = readHistory(context, 100) ?? [];
	let active = command === "rollback" ? history.find(entry=>entry.revision===context.inputs.revision) : history.filter((entry) => entry.status === "deployed").at(-1);
	if (command === "status" || command === "rollback") {
		if (active) {
			const values = JSON.parse(capture(context,"helm",["get","values",lane.release,"-n",lane.namespace,"--revision",String(active.revision),"-o","json"]));
			if (values.deploymentRelease) {
				const release=validateDeploymentRelease(values.deploymentRelease);
				context.receipt.sourceSha=release.source.sha;context.receipt.version=release.version;context.receipt.publication={runId:release.source.releaseRun,attempt:release.source.attempt};
			}
		}
		return;
	}
	// A successful empty release inventory proves absence; an unreadable history never does.
	if (!active && history.length === 0 && context.inputs.version) {
		const inventory=JSON.parse(capture(context,"helm",["list","--all","--filter",`^${lane.release}$`,"-n",lane.namespace,"-o","json"]));
		if (Array.isArray(inventory) && inventory.length === 0) active={revision:0,status:"absent",updated:""};
	}
	// A failed/pending newer revision needs its owner's disposition before a new deployment.
	if (!active || (active.revision !== 0 && active.revision !== history.at(-1)?.revision))
		throw new DeployError("DEPLOY_RELEASE_NOT_SETTLED", "production release needs its deployment owner's disposition");
	const live = active.revision > 0 ? JSON.parse(capture(context, "helm", ["get", "values", lane.release, "-n", lane.namespace, "--revision", String(active.revision), "-o", "json"])) : {};
	let release: DeploymentRelease;
	if (context.inputs.version) release = tagRelease(context, context.inputs.version);
	else if (live.deploymentRelease) release = validateDeploymentRelease(live.deploymentRelease);
	else {
		// One-time migration: old releases have no deploymentRelease metadata. Only accept the
		// private receipts when every running standard image matches, never lane.json's version pin.
		release = validateDeploymentRelease(JSON.parse(readFileSync(join(context.helm, "agent-infra", "environments", "prod", "release-migration.json"), "utf8")));
	}
	if (!context.inputs.version) {
		const roles: Record<string,string> = {web:"web",platformApi:"api",platformWorker:"worker",enterpriseDirectorySync:"directory"};
		const matches = (ref: unknown, image: {repository:string;digest:string}) => typeof ref === "string" && ref.endsWith(`/${image.repository.split("/").at(-1)}@${image.digest}`);
		for (const [key,role] of Object.entries(roles))
			if (!matches(live.images?.[role],release.manifests["platform-amd64"]!.images[key]!)) throw new DeployError("DEPLOY_CURRENT_RELEASE_UNKNOWN", "live workload images do not match the current release receipt");
		const runtime=release.manifests["runtime-host"]!.images.runtimeHost!;
		if (!matches(live.images?.runtimeHost && `${live.images.runtimeHost.repository}@${live.images.runtimeHost.digest}`,runtime)) throw new DeployError("DEPLOY_CURRENT_RELEASE_UNKNOWN", "live RuntimeHost does not match the current release receipt");
		for (const image of Object.values(release.manifests["templates-amd64"]!.images)) {
			const candidates=(live.imageCaches?.images ?? []).filter((ref: unknown)=>typeof ref === "string" && ref.includes(`/${image.repository.split("/").at(-1)}@`));
			if(candidates.length!==1 || !matches(candidates[0],image)) throw new DeployError("DEPLOY_CURRENT_RELEASE_UNKNOWN", "live current template images do not match the current release receipt");
		}
	}
	const identity = createHash("sha256").update(JSON.stringify({ revision: active.revision, release })).digest("hex");
	if (context.phase === "apply" && context.env.PLANNED_RELEASE !== identity)
		throw new DeployError("DEPLOY_RELEASE_MOVED", "production revision or selected publication changed after plan; start a new run");
	output(context, "release_identity", identity);
	context.selectedRevision = active.revision;
	context.receipt.sourceSha = release.source.sha;
	context.receipt.version = release.version;
	context.receipt.publication = { runId: release.source.releaseRun, attempt: release.source.attempt };
	const file = join(context.work, "release.json");
	writeFileSync(file, JSON.stringify(release), { mode: 0o600 });
	context.env.AGENT_INFRA_RELEASE_FILE = file;
	context.env.AGENT_INFRA_CHART_DIR = fileURLToPath(new URL("./chart", import.meta.url));
}

function connect(context: Context): void {
	const audience = context.env.KUBERNETES_OIDC_AUDIENCE ?? "";
	if (!/^[\w.:-]{1,128}$/u.test(audience)) throw new DeployError("DEPLOY_CONFIGURATION_MISSING", "Environment variable KUBERNETES_OIDC_AUDIENCE is not set");
	const ca = context.env.KUBERNETES_CA_FILE || caFile;
	if (!existsSync(ca)) throw new DeployError("DEPLOY_CONFIGURATION_MISSING", `${ca} is not mounted; is this the agent-infra-deploy runner?`);
	const kubeconfigFile = join(context.work, "kubeconfig");
	const credential = fileURLToPath(new URL("./github-oidc-credential.ts", import.meta.url));
	writeFileSync(kubeconfigFile, kubeconfig(audience, credential, ca), { mode: 0o600 });
	context.env.KUBECONFIG = kubeconfigFile;
	context.env.AGENT_INFRA_KUBECONFIG = kubeconfigFile;

	const secret = JSON.parse(capture(context, "kubectl", ["--request-timeout=30s", "-n", secretNamespace, "get", "secret", secretName, "-o", "json"])) as { data?: Record<string, string> };
	const value = (key: string) => (secret.data?.[key] ? Buffer.from(secret.data[key], "base64").toString("utf8") : undefined);
	const deployKey = value("helm-deploy-key");
	const knownHosts = value("known-hosts");
	const helmRepository = value("helm-repository")?.trim();
	if (!deployKey || !knownHosts || !helmRepository?.startsWith("ssh://"))
		throw new DeployError("DEPLOY_SECRET_MISSING", `${secretNamespace}/${secretName} needs helm-repository, helm-deploy-key and known-hosts`);
	const keyFile = join(context.work, "helm-deploy-key");
	const knownHostsFile = join(context.work, "known_hosts");
	writeFileSync(keyFile, deployKey.endsWith("\n") ? deployKey : `${deployKey}\n`, { mode: 0o600 });
	writeFileSync(knownHostsFile, knownHosts, { mode: 0o600 });
	delete context.env.AGENT_INFRA_TASK_ACCEPTANCE_FILE;
	if (context.inputs.command === "accept" || (context.inputs.command === "deploy" && context.phase === "apply")) {
		const acceptance = value("acceptance.json");
		if (acceptance) {
			let taskApi: unknown;
			try { taskApi = JSON.parse(acceptance)?.taskApi; } catch { /* Report the missing input at the acceptance step. */ }
			if (taskApi) {
				const file = join(context.work, "task-acceptance.json");
				writeFileSync(file, JSON.stringify(taskApi), { mode: 0o600 });
				context.env.AGENT_INFRA_TASK_ACCEPTANCE_FILE = file;
			}
		}
	}
	context.env.GIT_SSH_COMMAND = [
		"ssh", "-F", "/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`, "-i", keyFile,
	].join(" ");

	// Only the deployment repository's current main is deployable; read it right before cloning.
	const main = capture(context, "git", ["ls-remote", helmRepository, "refs/heads/main"]).split(/\s+/u)[0] ?? "";
	if (!sha40.test(main)) throw new DeployError("DEPLOY_HELM_MAIN_UNREADABLE", "cannot read the deployment repository main");
	if (context.inputs.helmCommit && context.inputs.helmCommit !== main)
		throw new DeployError("DEPLOY_HELM_COMMIT_NOT_MAIN", `helm_commit ${context.inputs.helmCommit} is not the current main ${main}`);
	const planned = context.env.PLANNED_HELM_COMMIT ?? "";
	if (context.phase === "apply" && planned !== main)
		throw new DeployError("DEPLOY_HELM_MAIN_MOVED", `main moved from the planned ${sha40.test(planned) ? planned : "unknown"} to ${main}; start a new run`);
	capture(context, "git", ["clone", "--quiet", "--depth", "1", "--branch", "main", helmRepository, context.helm]);
	if (capture(context, "git", ["-C", context.helm, "rev-parse", "HEAD"]).trim() !== main)
		throw new DeployError("DEPLOY_HELM_MAIN_MOVED", "main moved while cloning; start a new run");
	if (!existsSync(join(context.helm,"agent-infra","scripts","deployment-release.mjs")))
		throw new DeployError("DEPLOY_ENVIRONMENT_CONTRACT_REQUIRED", "private main must support runtime release inputs and the generic chart before dispatch");
	context.receipt.helmCommit = main;
	context.helmRepository = helmRepository;
	const lane = JSON.parse(readFileSync(join(context.helm, "agent-infra", "environments", "prod", "lane.json"), "utf8")) as {
		release?: unknown; namespace?: unknown; source?: { sha?: string }; standardTemplateRegistry?: unknown;
	};

	const name = /^[a-z0-9-]{1,53}$/u;
	if (typeof lane.release !== "string" || !name.test(lane.release) || typeof lane.namespace !== "string" || !name.test(lane.namespace))
		throw new DeployError("DEPLOY_LANE_INVALID", "lane.json needs release and namespace");
	context.lane = { release: lane.release, namespace: lane.namespace };
	prepareRelease(context, context.lane);
	const sourceSha = context.receipt.sourceSha ?? "";

	const needs = sourceNeeds(context.inputs.command, context.phase, lane.standardTemplateRegistry !== undefined);
	if (!needs.checkout) return;
	capture(context, process.execPath, [fileURLToPath(new URL("./source-checkout.ts", import.meta.url)), sourceSha, context.source]);
	context.env.AGENT_INFRA_SOURCE_WORKTREE = context.source;
	// verify loads packages/model-catalog/dist; build only that package and its workspace dependencies.
	// The lockfile pins every package's integrity, so the registry mirror cannot change what is installed.
	const env = { ...context.env, npm_config_registry: "https://registry.npmmirror.com" };
	if (needs.build) {
		const filters = ["--filter", "@agent-infra/model-catalog..."];
		if (lane.standardTemplateRegistry !== undefined) filters.push("--filter", "@agent-infra/image-registry...");
		capture(context, "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", ...filters], { env, cwd: context.source });
		capture(context, "pnpm", [...filters, "run", "build"], { env, cwd: context.source });
	}

}

function gate(context: Context): string[] {
	const file = join(context.work, "gate.json");
	required(context, "gate", ["gate", "--output", file]);
	const { reasons, summary } = gateSummary(JSON.parse(readFileSync(file, "utf8")));
	context.receipt.gate = summary;
	return failClosedReasons(reasons, summary);
}

function deployedAcceptanceRevision(context: Context): number {
	const latest = readHistory(context, 1)?.at(-1);
	const lane = context.lane;
	if (!lane || latest?.status !== "deployed" || !latest.revision ||
		(context.inputs.command === "accept" && latest.revision !== context.selectedRevision))
		throw new DeployError("DEPLOY_ACCEPT_RELEASE_CHANGED", "accept requires the selected deployed Helm revision");
	const live = JSON.parse(capture(context, "helm", ["get", "values", lane.release, "-n", lane.namespace, "--revision", String(latest.revision), "-o", "json"]));
	const selected = JSON.parse(readFileSync(context.env.AGENT_INFRA_RELEASE_FILE!, "utf8"));
	// Legacy standalone acceptance already checked all live images against the migration receipt at this revision.
	const legacy = !live.deploymentRelease && !selected.version && context.inputs.command === "accept";
	if (!legacy && !isDeepStrictEqual(live.deploymentRelease, selected))
		throw new DeployError("DEPLOY_ACCEPT_RELEASE_CHANGED", "the deployed release does not match the selected publication");
	return latest.revision;
}

async function accept(context: Context): Promise<void> {
	context.receipt.accept = {passed:false, templates:{}};
	const file = context.env.AGENT_INFRA_TASK_ACCEPTANCE_FILE;
	if (!file)
		throw new DeployError("DEPLOY_ACCEPT_INPUT_REQUIRED", "acceptance.json needs authorized Task API fixtures");
	const revision = deployedAcceptanceRevision(context);
	const run = context.receipt.run;
	if (!run || !context.receipt.sourceSha)
		throw new DeployError("DEPLOY_ACCEPT_INPUT_REQUIRED", "accept needs a workflow run, attempt and selected App source");
	const expected = {version: context.receipt.version ?? null, sourceSha: context.receipt.sourceSha, revision,
		run: run.id, attempt: run.attempt};
	context.env.AGENT_INFRA_ACCEPTANCE_REVISION = String(revision);
	const { exitCode, output } = await acceptanceStep(context);
	const receiptFile = output.match(/^receipt: (\/.+)$/mu)?.[1];
	const outcome = acceptOutcome(receiptFile && existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, "utf8")) : null, expected);
	context.receipt.accept = {...outcome, passed:false};
	if (exitCode !== 0 || !outcome.passed) throw new DeployError("DEPLOY_ACCEPT_FAILED", "business acceptance failed");
	if (deployedAcceptanceRevision(context) !== revision)
		throw new DeployError("DEPLOY_ACCEPT_RELEASE_CHANGED", "the deployed Helm revision changed during acceptance");
	context.receipt.accept.passed = true;
}

function readImageCaches(context: Context): void {
	try {
		const namespace = context.lane?.namespace ?? "";
		context.receipt.imageCaches = imageCacheSummary(JSON.parse(capture(context, "kubectl", [
			"--request-timeout=30s", "get", "imagecaches.eci.alibabacloud.com", "-l", `agent-infra.agora.io/cache-owner=${namespace}`, "-o", "json",
		])));
	} catch {
		context.receipt.imageCaches = { unreadable: true };
	}
}

async function plan(context: Context): Promise<void> {
	const { command } = context.inputs;
	context.receipt.revisionBefore = currentRevision(context);
	let reasons: string[] = [];
	if (command === "status") {
		required(context, "status", ["status"]);
		context.receipt.history = readHistory(context, 10);
		readImageCaches(context);
	}
	if (command === "diff") context.receipt.changes = diffChanges(required(context, "diff", ["diff"]));
	if (command === "verify") required(context, "verify", ["verify"]);
	if (command === "accept") await accept(context);
	if (command === "deploy") {
		reasons = gate(context);
		context.receipt.changes = diffChanges(required(context, "diff", ["diff"]));
	}
	if (command === "rollback") {
		required(context, "rollback check", ["rollback", String(context.inputs.revision), "--check"]);
		context.receipt.history = readHistory(context, 10);
	}
	context.receipt.approval = planApproval(command, reasons);
	output(context, "helm_commit", context.receipt.helmCommit ?? "");
	output(context, "apply", String(writes(command)));
	output(context, "approval_required", String(context.receipt.approval.required));
	output(context, "approval_reasons", context.receipt.approval.reasons.join(","));
}

async function apply(context: Context): Promise<void> {
	const { command } = context.inputs;
	if (!writes(command)) throw new DeployError("DEPLOY_INPUT_INVALID", `${command} has no apply phase`);
	const approved = context.env.APPROVAL_RESULT === "success";
	const plannedReasons = (context.env.PLANNED_REASONS ?? "").split(",").filter(Boolean);
	context.receipt.revisionBefore = currentRevision(context);
	// Re-read the gate: approval covers what the plan reported, not what changed since.
	const currentReasons = command === "deploy" ? gate(context) : [];
	context.receipt.approval = { ...planApproval(command, currentReasons), approved };
	const refused = admissionError({ command, approved, plannedReasons, currentReasons });
	if (refused) throw new DeployError("DEPLOY_APPROVAL_REQUIRED", refused);
	if (capture(context, "git", ["ls-remote", context.helmRepository ?? "", "refs/heads/main"]).split(/\s+/u)[0] !== context.receipt.helmCommit)
		throw new DeployError("DEPLOY_HELM_MAIN_MOVED", "environment main moved before writing; start a new run");
	try {
		if (command === "rollback") {
			required(context, "rollback", ["rollback", String(context.inputs.revision)]);
		} else {
			required(context, "deploy", ["deploy"]);
			readImageCaches(context);
			required(context, "verify", ["verify"]);
			await accept(context);
		}
	} finally {
		context.receipt.revisionAfter = currentRevision(context);
	}
}

function output(context: Context, name: string, value: string): void {
	if (!/^[\w.,:-]*$/u.test(value)) throw new DeployError("DEPLOY_OUTPUT_INVALID", `output ${name} has unexpected characters`);
	if (context.env.GITHUB_OUTPUT) appendFileSync(context.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Keeps the command output in the cluster, readable with the operator kubeconfig; prunes old logs. */
function storeLog(context: Context): void {
	const run = context.receipt.run;
	if (!run || !context.env.KUBECONFIG) return;
	const name = `deploy-log-${run.id}-${run.attempt}-${context.phase}`;
	// A Secret holds at most 1 MiB; keep the tail of the output that fits.
	const full = readFileSync(context.log);
	let compressed = gzipSync(full);
	for (let keep = 2 * 1024 * 1024; compressed.length > 700 * 1024 && keep >= 64 * 1024; keep /= 2)
		compressed = gzipSync(full.subarray(Math.max(0, full.length - keep)));
	const manifest = {
		apiVersion: "v1",
		kind: "Secret",
		metadata: { name, namespace: secretNamespace, labels: { "agent-infra.agora.io/deploy-log": "true" } },
		type: "Opaque",
		data: { "output.log.gz": compressed.toString("base64") },
	};
	try {
		capture(context, "kubectl", ["--request-timeout=30s", "apply", "--server-side", "--field-manager=deploy-executor", "-f", "-"], { input: JSON.stringify(manifest) });
		context.receipt.log = name;
		const logs = JSON.parse(capture(context, "kubectl", ["--request-timeout=30s", "-n", secretNamespace, "get", "secrets", "-l", "agent-infra.agora.io/deploy-log=true", "-o", "json"])) as {
			items: Array<{ metadata: { name: string; creationTimestamp: string } }>;
		};
		const old = logs.items.sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp)).slice(keptLogs);
		for (const item of old) capture(context, "kubectl", ["--request-timeout=30s", "-n", secretNamespace, "delete", "secret", item.metadata.name, "--ignore-not-found"]);
	} catch {
		console.log("command output could not be stored in the cluster");
	}
}

export async function main(phase: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const temp = env.RUNNER_TEMP ?? "";
	if (phase !== "plan" && phase !== "apply") throw new Error("usage: production-deploy.ts <plan|apply>");
	if (!temp.startsWith("/")) throw new Error("RUNNER_TEMP must be an absolute path");
	const work = resolve(temp, "deploy-executor");
	mkdirSync(work, { recursive: true, mode: 0o700 });
	const receipt: Receipt = {
		schemaVersion: 1,
		kind: "agent-infra-production-deploy",
		phase,
		...(env.GITHUB_RUN_ID && /^\d+$/u.test(env.GITHUB_RUN_ID) ? { run: { id: env.GITHUB_RUN_ID, attempt: /^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? "") ? (env.GITHUB_RUN_ATTEMPT as string) : "1" } } : {}),
		steps: [],
	};
	const context: Context = {
		inputs: { command: "status" },
		phase,
		work,
		log: join(work, "output.log"),
		receipt,
		// CUTOVER=1: the lane already serves its production hosts; deploy.sh still refuses to move them.
		// deploy.sh writes its internal registry check here (diff, deploy); step() moves it into the receipt.
		env: { ...env, CUTOVER: "1", ASSUME_YES: "1", AGENT_INFRA_STATE_DIR: join(work, "state"), AGENT_INFRA_IMAGE_CHECK_OUTPUT: join(work, "image-check.json") },
		helm: join(work, "helm"),
		source: join(work, "source"),
	};
	writeFileSync(context.log, "", { mode: 0o600 });
	try {
		context.inputs = parseInputs(env);
		receipt.command = context.inputs.command;
		connect(context);
		if (phase === "plan") await plan(context);
		else await apply(context);
		receipt.passed = true;
	} catch (error) {
		receipt.passed = false;
		receipt.error = (error instanceof DeployError ? error.message : "DEPLOY_FAILED: unexpected error; see the command output Secret").slice(0, 500);
		appendFileSync(context.log, `\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		console.error(receipt.error);
	} finally {
		storeLog(context);
		writeFileSync(join(temp, "deploy-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(receipt));
	}
	return receipt.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = await main(process.argv[2] ?? "");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
