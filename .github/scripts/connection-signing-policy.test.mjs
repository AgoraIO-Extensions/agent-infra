import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import YAML from "yaml";
import { validateConnectionSigningWorkflow } from "./verify-workflow-policy.mjs";

const current = () => YAML.parse(readFileSync(".github/workflows/publish-ghcr.yml", "utf8"));
test("only protected Connection tag identity receives OIDC signing permissions", () => {
  assert.deepEqual(validateConnectionSigningWorkflow(current()), []);
  for (const mutate of [
    (workflow) => { workflow.permissions["id-token"] = "write"; },
    (workflow) => { workflow.jobs.publish.permissions = { "id-token": "write" }; },
    (workflow) => { workflow.jobs["connection-evidence"].if = "true"; },
    (workflow) => { workflow.jobs["connection-evidence"].strategy.matrix.name.push("platform-api"); },
    (workflow) => { workflow.jobs["connection-evidence"].permissions.contents = "write"; },
    (workflow) => { workflow.jobs["connection-evidence"].steps.find((step) => step.name === "Sign and independently verify release evidence").run = "echo verified"; },
  ]) {
    const workflow = current(); mutate(workflow);
    assert.ok(validateConnectionSigningWorkflow(workflow).length > 0);
  }
});
