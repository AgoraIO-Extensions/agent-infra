import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { selectCurrentGateCheck } from "./check-run-contract.mjs";
import { extractPrimaryIssueNumbers } from "./pr-gates.mjs";
import { githubRequest, PrAgentTargetSuperseded, requirePrAgentTarget, verifyPrAgentPublication } from "./pr-agent-review.mjs";

const CHECK = "Automated Review Coverage";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
export const issueContractHash = (issue) => hash(`${issue.title}\0${issue.body}`);

export function readScopeSummary(summary, key) {
  const values = String(summary ?? "").split("\n").filter((line) => line.startsWith(`${key}: `));
  if (values.length !== 1) return null;
  try { return JSON.parse(values[0].slice(key.length + 2)); } catch { return null; }
}

function assertScope(scope) {
  if (!scope || scope.version !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(scope.repository) ||
      !Number.isSafeInteger(scope.prNumber) || scope.prNumber < 1 ||
      !["full", "incremental", "unchanged"].includes(scope.mode) ||
      ![scope.fromSha, scope.headSha, scope.mergeBaseSha].every(sha) ||
      typeof scope.baseRef !== "string" || !scope.baseRef || scope.baseRef.length > 255 ||
      !Number.isSafeInteger(scope.issueNumber) || scope.issueNumber < 1 ||
      !hashPattern.test(scope.issueHash) || !hashPattern.test(scope.diffSha256) ||
      !Number.isSafeInteger(scope.diffBytes) || scope.diffBytes < 0 || scope.diffBytes > 10 * 1024 * 1024 ||
      (scope.mode === "full" ? scope.fromSha !== scope.mergeBaseSha || scope.baseline !== undefined
        : !Number.isSafeInteger(scope.baseline?.checkId) || scope.baseline.checkId < 1 || scope.baseline.headSha !== scope.fromSha)) {
    throw new Error("PR-Agent review scope is invalid");
  }
}

async function certifiedScope(check, context) {
  const scope = readScopeSummary(check?.output?.summary, "review_scope");
  const receipt = readScopeSummary(check?.output?.summary, "publication_receipt");
  if (!scope || !receipt || check.conclusion !== "success" || check.status !== "completed") return null;
  // An old or malformed successful-looking Check is not a trusted baseline;
  // ignore it and let this head start from the current merge base.
  try { assertScope(scope); } catch { return null; }
  if (!selectCurrentGateCheck([check], { name: CHECK, headSha: scope.headSha, prNumber: context.prNumber }) ||
      scope.repository !== context.repository || scope.prNumber !== context.prNumber ||
      receipt.headSha !== scope.headSha || JSON.stringify(receipt.scope) !== JSON.stringify(scope) ||
      check.details_url !== `https://github.com/${context.repository}/actions/runs/${receipt.runId}` ||
      !/^provider: pr-agent$/m.test(check.output.summary) ||
      !/^reason_code: complete(?:-incremental|-unchanged)?$/m.test(check.output.summary)) return null;
  if (!(await verifyPrAgentPublication({ ...context, expectedHead: scope.headSha,
    runId: receipt.runId, attempt: receipt.attempt, receipt }))) return null;
  return scope;
}

async function findBaseline(context, primary, baseRef, mergeBaseSha) {
  const reviews = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await context.request(`/repos/${context.repository}/pulls/${context.prNumber}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("PR-Agent baseline review list is invalid");
    reviews.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) throw new Error("PR-Agent baseline review list is incomplete");
  }
  const seen = new Set();
  for (const review of reviews.reverse()) {
    if (review.user?.id !== 41898282 || review.user?.login !== "github-actions[bot]" ||
        review.user?.type !== "Bot" || !sha(review.commit_id) || seen.has(review.commit_id) ||
        !String(review.body).includes("<!-- agent-infra:pr-agent-review:")) continue;
    seen.add(review.commit_id);
    const response = await context.request(`/repos/${context.repository}/commits/${review.commit_id}/check-runs?check_name=${encodeURIComponent(CHECK)}&filter=latest&per_page=100`);
    if (!Array.isArray(response.check_runs) || response.total_count > response.check_runs.length)
      throw new Error("PR-Agent baseline check list is incomplete");
    const check = selectCurrentGateCheck(response.check_runs, { name: CHECK, headSha: review.commit_id, prNumber: context.prNumber });
    const scope = await certifiedScope(check, context);
    if (!scope || scope.issueNumber !== primary.issueNumber || scope.issueHash !== primary.contractSha256 ||
        scope.baseRef !== baseRef || scope.mergeBaseSha !== mergeBaseSha) continue;
    const comparison = await context.request(`/repos/${context.repository}/compare/${scope.headSha}...${context.expectedHead}`);
    if (comparison.merge_base_commit?.sha === scope.headSha && ["ahead", "identical"].includes(comparison.status))
      return { checkId: check.id, headSha: scope.headSha };
  }
  return null;
}

// Git accepts both literal UTF-8 and C-quoted paths. Compare metadata against
// the API identity without parsing ambiguous spaces or escapes ourselves.
function gitPaths(path) {
  const quoted = [...Buffer.from(path)].map((byte) => {
    if (byte === 34 || byte === 92) return `\\${String.fromCharCode(byte)}`;
    if (byte < 32 || byte >= 127) return `\\${byte.toString(8).padStart(3, "0")}`;
    return String.fromCharCode(byte);
  }).join("");
  // Git spells these control characters with named escapes.
  const named = quoted.replace(/\\(007|010|011|012|013|014|015)/g,
    (_, octal) => `\\${{ "007": "a", "010": "b", "011": "t", "012": "n", "013": "v", "014": "f", "015": "r" }[octal]}`);
  return [path, `"${quoted}"`, `"${named}"`];
}

export function validateDiffInput(diff, files) {
  if (typeof diff !== "string" || Buffer.byteLength(diff) > 10 * 1024 * 1024 ||
      !Array.isArray(files) || files.length >= 300) throw new Error("PR-Agent range diff is incomplete or too large");
  const identities = new Map();
  for (const file of files) {
    if (!file || typeof file.filename !== "string" || !file.filename || file.filename.includes("\0") ||
        identities.has(file.filename) || !["added", "removed", "modified", "renamed"].includes(file.status) ||
        (file.status === "renamed" ? typeof file.previous_filename !== "string" || !file.previous_filename ||
          file.previous_filename === file.filename || file.previous_filename.includes("\0") : file.previous_filename !== undefined))
      throw new Error("PR-Agent range file identity is invalid");
    identities.set(file.filename, file);
  }
  const blocks = diff ? diff.split(/(?=^diff --git )/m) : [];
  if (blocks.length !== files.length) throw new Error("PR-Agent range diff does not match immutable file identities");
  const seen = new Set();
  for (const block of blocks) {
    let stat;
    try {
      stat = execFileSync("git", ["apply", "--numstat", "-z", "--allow-empty"],
        { input: block, encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    } catch { throw new Error("PR-Agent range diff cannot be parsed"); }
    const match = /^(\d+|-)\t(\d+|-)\t([^\0]+)\0$/.exec(stat);
    if (!match) throw new Error("PR-Agent range file identity is invalid");
    if (match[1] === "-" || match[2] === "-") throw new Error("PR-Agent range contains unsupported binary changes");
    const file = identities.get(match[3]);
    if (!file || seen.has(match[3])) throw new Error("PR-Agent range diff does not match immutable file identities");
    seen.add(match[3]);
    const lines = block.split("\n");
    const oldPath = file.previous_filename ?? file.filename;
    if (!gitPaths(`a/${oldPath}`).some((a) => gitPaths(`b/${file.filename}`).some((b) => lines[0] === `diff --git ${a} ${b}`)))
      throw new Error("PR-Agent range diff does not match immutable file identities");
    const hunkStart = lines.findIndex((line) => line.startsWith("@@ "));
    const header = lines.slice(1, hunkStart === -1 ? -1 : hunkStart);
    if (!block.endsWith("\n") || header.some((line) =>
      !/^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to |--- |\+\+\+ )/.test(line)))
      throw new Error("PR-Agent range diff cannot be parsed");
    const metadata = (prefix) => header.filter((line) => line.startsWith(prefix));
    const hasPath = (prefix, path) => {
      const values = metadata(prefix);
      const value = ["--- ", "+++ "].includes(prefix) ? values[0]?.replace(/\t$/, "") : values[0];
      return values.length === 1 && gitPaths(path).some((encoded) => value === prefix + encoded);
    };
    const added = metadata("new file mode ").length;
    const removed = metadata("deleted file mode ").length;
    const renamed = metadata("rename from ").length + metadata("rename to ").length;
    if (added !== Number(file.status === "added") || removed !== Number(file.status === "removed") ||
        renamed !== (file.status === "renamed" ? 2 : 0) ||
        (renamed && (!hasPath("rename from ", oldPath) || !hasPath("rename to ", file.filename))) ||
        (metadata("--- ").length + metadata("+++ ").length > 0 &&
          (!hasPath("--- ", file.status === "added" ? "/dev/null" : `a/${oldPath}`) ||
           !hasPath("+++ ", file.status === "removed" ? "/dev/null" : `b/${file.filename}`))))
      throw new Error("PR-Agent range diff does not match immutable file status");
    const headerKeys = header.map((line) => /^(index |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to |--- |\+\+\+ )/.exec(line)[0]);
    if (new Set(headerKeys).size !== headerKeys.length ||
        (hunkStart === -1 && (metadata("--- ").length || metadata("+++ ").length)))
      throw new Error("PR-Agent range diff cannot be parsed");
    if (hunkStart === -1) {
      const index = /^index ([a-f0-9]+)\.\.([a-f0-9]+)(?: [0-7]{6})?$/.exec(metadata("index ")[0] ?? "");
      const emptyBlob = (value) => value?.length >= 7 && "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391".startsWith(value);
      const unchangedContent = !metadata("index ").length || (index && index[1] === index[2]);
      const modeChange = /^old mode [0-7]{6}$/.test(metadata("old mode ")[0] ?? "") &&
        /^new mode [0-7]{6}$/.test(metadata("new mode ")[0] ?? "") &&
        metadata("old mode ")[0].slice(9) !== metadata("new mode ")[0].slice(9);
      const valid = file.status === "added" ? index && /^0+$/.test(index[1]) && emptyBlob(index[2])
        : file.status === "removed" ? index && emptyBlob(index[1]) && /^0+$/.test(index[2])
        : file.status === "renamed" ? unchangedContent && metadata("similarity index ")[0] === "similarity index 100%"
        : unchangedContent && modeChange;
      if (!valid) throw new Error("PR-Agent range diff is missing content hunks");
    }
    // Git can ignore trailing text. Consume every hunk ourselves, then compare
    // actual line counts to numstat; API statistics are never authoritative.
    let oldRemaining = 0;
    let newRemaining = 0;
    let additions = 0;
    let deletions = 0;
    let previousLine;
    for (const line of hunkStart === -1 ? [] : lines.slice(hunkStart, -1)) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (hunk && oldRemaining === 0 && newRemaining === 0) {
        oldRemaining = Number(hunk[1] ?? 1);
        newRemaining = Number(hunk[2] ?? 1);
        if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining) ||
            oldRemaining + newRemaining === 0) throw new Error("PR-Agent range diff cannot be parsed");
      } else if (line === "\\ No newline at end of file" && /^[ +\-]/.test(previousLine ?? "")) {
        // This marker does not consume a source line.
      } else if (/^[ +\-]/.test(line)) {
        if (line[0] !== "+") oldRemaining--;
        if (line[0] !== "-") newRemaining--;
        if (line[0] === "+") additions++;
        if (line[0] === "-") deletions++;
        if (oldRemaining < 0 || newRemaining < 0) throw new Error("PR-Agent range diff cannot be parsed");
      } else throw new Error("PR-Agent range diff cannot be parsed");
      previousLine = line;
    }
    if (oldRemaining || newRemaining || Number(match[1]) !== additions || Number(match[2]) !== deletions)
      throw new Error("PR-Agent range diff does not match immutable hunk counts");
  }
  return { diffSha256: hash(diff), diffBytes: Buffer.byteLength(diff) };
}

async function readRange(context, fromSha) {
  const path = `/repos/${context.repository}/compare/${fromSha}...${context.expectedHead}`;
  const comparison = await context.request(path);
  if (comparison.merge_base_commit?.sha !== fromSha || !["ahead", "identical"].includes(comparison.status))
    throw new Error("PR-Agent range baseline is not an ancestor");
  const diff = await context.request(path, { responseType: "text", headers: { Accept: "application/vnd.github.diff" } });
  return { diff, ...validateDiffInput(diff, comparison.files) };
}

export async function prepareReviewScope(context, primary) {
  let current;
  try { current = await requirePrAgentTarget(context); }
  catch (error) {
    if (error instanceof PrAgentTargetSuperseded) return { applicable: false, reason: error.reason };
    throw error;
  }
  if (current.head.repo?.full_name !== context.repository || current.base?.repo?.full_name !== context.repository ||
      primary.headSha !== context.expectedHead || !hashPattern.test(primary.contractSha256))
    throw new Error("PR-Agent scope target identity is invalid");
  const comparison = await context.request(`/repos/${context.repository}/compare/${current.base.sha}...${context.expectedHead}`);
  const mergeBaseSha = comparison.merge_base_commit?.sha;
  if (!sha(mergeBaseSha)) throw new Error("PR-Agent merge base is invalid");
  const baseline = await findBaseline(context, primary, current.base.ref, mergeBaseSha);
  if (baseline?.headSha === context.expectedHead) return { applicable: false, reason: "already-reviewed" };
  const fromSha = baseline?.headSha ?? mergeBaseSha;
  const { diff, ...fingerprint } = await readRange(context, fromSha);
  if (!baseline && fingerprint.diffBytes === 0) return { applicable: false, reason: "empty-pr" };
  const scope = {
    version: 1, repository: context.repository, prNumber: context.prNumber,
    mode: baseline ? (fingerprint.diffBytes ? "incremental" : "unchanged") : "full",
    fromSha, headSha: context.expectedHead, mergeBaseSha, baseRef: current.base.ref,
    issueNumber: primary.issueNumber, issueHash: primary.contractSha256,
    ...fingerprint, ...(baseline ? { baseline } : {}),
  };
  assertScope(scope);
  return { applicable: true, scope, diff };
}

export async function verifyReviewScope(context, scope) {
  assertScope(scope);
  if (scope.repository !== context.repository || scope.prNumber !== context.prNumber || scope.headSha !== context.expectedHead)
    throw new Error("PR-Agent scope belongs to another target");
  const current = await requirePrAgentTarget(context);
  if (current.base?.ref !== scope.baseRef ||
      current.head?.repo?.full_name !== context.repository || current.base?.repo?.full_name !== context.repository)
    throw new Error("PR-Agent scope target is superseded");
  const numbers = extractPrimaryIssueNumbers(current.body ?? "");
  if (numbers.length !== 1 || numbers[0] !== scope.issueNumber) throw new Error("PR-Agent scope primary changed");
  const issue = await context.request(`/repos/${context.repository}/issues/${scope.issueNumber}`);
  if (issue.state !== "open" || issue.pull_request || issueContractHash(issue) !== scope.issueHash)
    throw new Error("PR-Agent scope contract changed");
  const comparison = await context.request(`/repos/${context.repository}/compare/${current.base.sha}...${scope.headSha}`);
  if (comparison.merge_base_commit?.sha !== scope.mergeBaseSha) throw new Error("PR-Agent scope merge base changed");
  if (scope.baseline) {
    const check = await context.request(`/repos/${context.repository}/check-runs/${scope.baseline.checkId}`);
    const previous = await certifiedScope(check, context);
    if (!previous || previous.headSha !== scope.fromSha || previous.mergeBaseSha !== scope.mergeBaseSha ||
        previous.baseRef !== scope.baseRef || previous.issueNumber !== scope.issueNumber || previous.issueHash !== scope.issueHash)
      throw new Error("PR-Agent scope baseline is not certified");
  }
  const range = await readRange(context, scope.fromSha);
  if (range.diffSha256 !== scope.diffSha256 || range.diffBytes !== scope.diffBytes ||
      (scope.mode === "unchanged") !== (range.diffBytes === 0)) throw new Error("PR-Agent scope input changed");
  return range;
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const plan = await prepareReviewScope({ repository: process.env.GITHUB_REPOSITORY,
    prNumber: event.pull_request?.number, expectedHead: event.pull_request?.head?.sha,
    request: githubRequest }, JSON.parse(process.env.PRIMARY_ISSUE_EVIDENCE));
  if (!plan.applicable) {
    await appendFile(process.env.GITHUB_OUTPUT, `applicable=false\nreason=${plan.reason}\n`);
    console.log(`PR-Agent scope skipped: ${plan.reason}`);
    return;
  }
  await writeFile(".pr-agent-review-input.diff", plan.diff, { mode: 0o600 });
  await appendFile(process.env.GITHUB_OUTPUT, `applicable=true\nmode=${plan.scope.mode}\nscope=${JSON.stringify(plan.scope)}\n`);
  console.log(`PR-Agent review scope: ${JSON.stringify(plan.scope)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("PR-Agent review scope preparation failed"); process.exitCode = 1; });
}
