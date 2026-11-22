import { runRuntimeOAuthProvisioningInitV1 } from "./runtime-oauth-provisioning.js";

const failure = await runRuntimeOAuthProvisioningInitV1(process.env);
// The Host rejects incomplete bootstrap; ordinary model/control startup continues.
if (failure) process.stderr.write(failure);
