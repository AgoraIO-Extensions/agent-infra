import {
	establishCredentialHolderSessionScopeV1,
	protectCredentialHolderProcessV1,
} from "./credential-holder-protection.js";
import { runRuntimeOAuthProvisioningInitV1 } from "./runtime-oauth-provisioning.js";

// First, before reading any source or creating a child (ADR-0051). The init runs
// before any tool process exists in its PID namespace and has no Session to verify.
protectCredentialHolderProcessV1();
establishCredentialHolderSessionScopeV1({ kind: "provisioning-init" });

const failure = await runRuntimeOAuthProvisioningInitV1(process.env);
// The Host rejects incomplete bootstrap; ordinary model/control startup continues.
if (failure) process.stderr.write(failure);
