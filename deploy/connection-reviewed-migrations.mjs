import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const repository = "AgoraIO-Extensions/agent-infra";
const journalPath = "migrations/connection/meta/_journal.json";
function command(binary, args, trim = true) {
  try { const value = execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return trim ? value.trim() : value; }
  catch { throw new Error("Reviewed migration command failed; raw output withheld"); }
}
const git = (...args) => command("git", args);
const gitFile = (ref, path) => command("git", ["show", `${ref}:${path}`], false);

export function validateMigrationPlan(before, after, changes) {
  const oldEntries = before.entries;
  const newEntries = after.entries;
  if (!Array.isArray(oldEntries) || !Array.isArray(newEntries) || newEntries.length <= oldEntries.length ||
      JSON.stringify(oldEntries) !== JSON.stringify(newEntries.slice(0, oldEntries.length)))
    throw new Error("Migration journal must append without rewriting existing entries");
  const added = newEntries.slice(oldEntries.length).map((entry) => {
    if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) throw new Error("Invalid migration name");
    return `migrations/connection/${entry.tag}.sql`;
  });
  if (changes.length !== added.length + 1 || !changes.some(([status, path]) => status === "M" && path === journalPath) ||
      added.some((path) => !changes.some(([status, candidate]) => status === "A" && candidate === path)))
    throw new Error("Reviewed releases accept only added SQL and an append-only journal");
  return added;
}

export function validateMigrationReview(pr) {
  if (pr.state !== "MERGED" || !/^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid ?? "") ||
      !/^[a-f0-9]{40}$/.test(pr.headRefOid ?? "")) throw new Error("A merged migration PR is required");
}

export function reviewedMigrationPlan(prNumber, baseline, candidate = "HEAD") {
  if (!/^[1-9][0-9]*$/.test(String(prNumber))) throw new Error("An explicit reviewed migration PR is required");
  const pr = JSON.parse(command("gh", ["pr", "view", String(prNumber), "--repo", repository,
    "--json", "state,headRefOid,mergeCommit"]));
  validateMigrationReview(pr);
  git("merge-base", "--is-ancestor", pr.mergeCommit.oid, candidate);
  const before = JSON.parse(gitFile(baseline, journalPath));
  const after = JSON.parse(gitFile(candidate, journalPath));
  const changes = git("diff", "--name-status", baseline, candidate, "--", "migrations/connection")
    .split("\n").filter(Boolean).map((line) => line.split("\t"));
  const added = validateMigrationPlan(before, after, changes);
  if (added.some((path) => gitFile(pr.mergeCommit.oid, path) !== gitFile(candidate, path)) ||
      gitFile(pr.mergeCommit.oid, journalPath) !== gitFile(candidate, journalPath))
    throw new Error("Candidate migration bytes are not covered by the reviewed PR");
  return { prNumber: Number(prNumber), sha: git("rev-parse", candidate), added,
    hashes: after.entries.map((entry) => createHash("sha256").update(
      // Hash exact Git bytes, including the final newline, as Drizzle does.
      execFileSync("git", ["show", `${candidate}:migrations/connection/${entry.tag}.sql`]),
    ).digest("hex")) };
}

export function migrationJob(version, plan, api, target) {
  if (!/^connection-v\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(plan.sha)) throw new Error("Invalid migration release identity");
  const pod = api.spec.template.spec;
  const apiContainer = pod.containers.find((container) => container.name === "api");
  const caMount = apiContainer.volumeMounts.find((mount) => mount.mountPath === "/etc/connection-rds");
  const name = "connection-migrate-" + version.replaceAll(".", "-");
  const container = { name: "migrate", image: `ghcr.io/agoraio-extensions/agent-infra/connection-api:${version}`,
    imagePullPolicy: "Always", command: ["node", "dist/bootstrap-production.mjs"],
    env: [ { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: target.databaseSecret, key: "DATABASE_URL" } } },
      { name: "NODE_EXTRA_CA_CERTS", value: target.caPath } ],
    volumeMounts: [caMount], resources: apiContainer.resources };
  return { apiVersion: "batch/v1", kind: "Job", metadata: { name, namespace: target.namespace,
    annotations: { "connection/source-sha": plan.sha, "connection/migration-pr": String(plan.prNumber) } },
    spec: { backoffLimit: 0, activeDeadlineSeconds: 300, template: { metadata: {
      labels: { "app.kubernetes.io/name": "connection-migration" } }, spec: {
      restartPolicy: "Never", automountServiceAccountToken: false,
      nodeSelector: pod.nodeSelector, tolerations: pod.tolerations, affinity: pod.affinity,
      imagePullSecrets: pod.imagePullSecrets, containers: [container],
      volumes: pod.volumes.filter((volume) => volume.name === caMount.name) } } } };
}

export function validateMigrationReceipt(receipt, plan) {
  if (receipt?.migrationReceiptVersion !== 1 || !Array.isArray(receipt.hashes) ||
      JSON.stringify(receipt.hashes) !== JSON.stringify(plan.hashes))
    throw new Error("Migration receipt does not match committed SQL hashes");
}

export async function applyReviewedMigrations(kube, job, plan, createJob) {
  const namespace = job.metadata.namespace, name = job.metadata.name;
  const list = JSON.parse(kube("-n", namespace, "get", "job", name, "--ignore-not-found", "-o", "json") || "null");
  if (list) {
    if (list.metadata.annotations?.["connection/source-sha"] !== plan.sha ||
        list.spec.template.spec.containers[0].image !== job.spec.template.spec.containers[0].image ||
        JSON.stringify(list.spec.template.spec.containers[0].command) !== JSON.stringify(job.spec.template.spec.containers[0].command) ||
        JSON.stringify(list.spec.template.spec.containers[0].env) !== JSON.stringify(job.spec.template.spec.containers[0].env) || list.status?.failed)
      throw new Error("Existing migration Job is mismatched or failed; inspect without automatic retry");
    if (list.spec.backoffLimit !== 0 || list.spec.activeDeadlineSeconds !== 300 ||
        list.spec.template.spec.automountServiceAccountToken !== false ||
        JSON.stringify(list.spec.template.spec.containers[0].volumeMounts) !== JSON.stringify(job.spec.template.spec.containers[0].volumeMounts) ||
        JSON.stringify(list.spec.template.spec.volumes) !== JSON.stringify(job.spec.template.spec.volumes))
      throw new Error("Existing migration Job changed its safety or TLS settings");
  } else {
    createJob(job);
  }
  const deadline = Date.now() + 310_000;
  while (Date.now() < deadline) {
    const current = JSON.parse(kube("-n", namespace, "get", "job", name, "-o", "json"));
    if (current.status?.failed) throw new Error("Migration Job failed; no images were patched");
    if (current.status?.succeeded === 1) {
      const logs = kube("-n", namespace, "logs", `job/${name}`, "--container=migrate");
      const receipts = logs.split("\n").flatMap((line) => { try { const value = JSON.parse(line); return value.migrationReceiptVersion ? [value] : []; } catch { return []; } });
      if (receipts.length !== 1) throw new Error("Migration Job has no unique ledger receipt");
      validateMigrationReceipt(receipts[0], plan);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Migration Job state is unknown; no images were patched");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const [pr, baseline, candidate] = process.argv.slice(2); const plan = reviewedMigrationPlan(pr, baseline, candidate); console.log(JSON.stringify(plan)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
