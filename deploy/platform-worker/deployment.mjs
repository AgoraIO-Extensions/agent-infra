import { randomUUID } from "node:crypto";
import {
 createProductionConversationRuntimeResolverV2,
 createProductionWorkloadWorkerOptionsV1,
 createWorkloadReadinessAuthorizationV1,
 createWecomDeploymentCoordinatorV1,
} from "@agent-infra/platform-worker";

// Deployment-owned code supplies current IdentityAdapter facts and Worker-only material.
// The adjacent configuration.mjs is mounted by the deployment, never bundled into the image.
const { workloadInput, signing, serviceToken, directory, wecom } = await import(
 new URL("./configuration.mjs", import.meta.url).href
);

const instanceId = randomUUID();
let prepared;
async function prepare(signal) {
 prepared ??= (async () => {
  const workload = await createProductionWorkloadWorkerOptionsV1({
   ...workloadInput,
   workerId: signing.workerId,
   runtimeProbe: createWorkloadReadinessAuthorizationV1({ ...signing, serviceToken }),
  }, signal);
  const wecomDeployment = createWecomDeploymentCoordinatorV1({
   databaseUrl: workload.databaseUrl,
   configuration: wecom,
  });
  return {
   // Database lease ownership is per process; Runtime service identity is deployment-bound.
   workload: { ...workload, workerId: instanceId },
   conversation: {
    databaseUrl: workload.databaseUrl,
    workerId: instanceId,
    signing,
    directory,
    channelAuthorizationCurrent: wecomDeployment.channelAuthorizationCurrent,
    resolveRuntimeHost: createProductionConversationRuntimeResolverV2({ workload, signing, serviceToken }),
    fetch: workload.fetch,
   },
   wecom: wecomDeployment,
  };
 })();
 return prepared;
}
export async function createPlatformWorkloadWorkerOptionsV1(signal) {
 return (await prepare(signal)).workload;
}
export async function createPlatformConversationWorkerOptionsV2(signal) {
 return (await prepare(signal)).conversation;
}
export async function createPlatformWecomWorkerInstanceV1(signal) {
 return (await prepare(signal)).wecom.start(signal);
}
