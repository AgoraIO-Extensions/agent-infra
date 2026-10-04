import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { githubRequest, requirePrAgentTarget } from './pr-agent-review.mjs';
const env = process.env;
type CertifiedScope = { mode: string; repository: string; prNumber: number; headSha: string; mergeBaseSha: string; diffSha256: string; diffBytes: number };
try {
  if (Number(env.REVIEW_TOKEN_CAP) !== 300000) throw new Error('cap mismatch');
  const scope = JSON.parse(env.PR_AGENT_REVIEW_SCOPE ?? '') as CertifiedScope;
  if (scope.mode !== 'full' || scope.repository !== env.GITHUB_REPOSITORY) throw new Error('scope mismatch');
  if (typeof scope.diffSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(scope.diffSha256) ||
      !Number.isSafeInteger(scope.diffBytes) || scope.diffBytes < 1) throw new Error('invalid certified diff fingerprint');
  const current = await requirePrAgentTarget({repository: scope.repository, prNumber: scope.prNumber, expectedHead: scope.headSha, request: githubRequest});
  if (![current.base?.sha, scope.headSha].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('invalid SHA');
  const run = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (![run, attempt].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('invalid run');
  const jobs = await githubRequest(`/repos/${scope.repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) throw new Error('incomplete jobs');
  const matching = jobs.jobs.filter((job: { name: string; run_id: number; run_attempt: number; status: string; id: number }) => job.name === 'PR-Agent Analysis' && job.run_id === run && job.run_attempt === attempt && job.status === 'in_progress');
  if (matching.length !== 1 || !Number.isSafeInteger(matching[0].id)) throw new Error('ambiguous Analysis job');
  const fetchEnv = {...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString('base64')}`, GIT_TERMINAL_PROMPT: '0'};
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {encoding:'utf8'}).trim() === 'true';
  execFileSync('git', ['-c','core.hooksPath=/dev/null','fetch','--no-tags','--no-write-fetch-head',...(shallow ? ['--unshallow'] : []),`https://github.com/${scope.repository}.git`,current.base.sha,scope.headSha], {env:fetchEnv, stdio:'pipe'});
  const recorderBytes = await readFile('packages/review-coverage/dist/index.mjs');
  const recorderVersion = `sha256:${createHash('sha256').update(recorderBytes).digest('hex')}`;
  if (!env.GITHUB_OUTPUT) throw new Error('missing output');
  await appendFile(env.GITHUB_OUTPUT, `recorder_version=${recorderVersion}\nanalysis_job_id=${matching[0].id}\nbase_sha=${current.base.sha}\nhead_sha=${scope.headSha}\nmerge_base_sha=${scope.mergeBaseSha}\npr_number=${scope.prNumber}\ndiff_sha256=${scope.diffSha256}\ndiff_bytes=${scope.diffBytes}\n`);
} catch {
  console.error('review-output-invalid: trusted full-scope preparation failed');
  process.exitCode = 1;
}
