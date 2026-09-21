import { metadata } from "./metadata.mjs";
import { digestVectors } from "./digest-vectors.mjs";
import { framingCases } from "./framing-cases.mjs";
import { jcsVectors } from "./jcs-vectors.mjs";
import { cases as v1OperationCases } from "./v1-operation-cases.mjs";
import { cases as v1SourceCases } from "./v1-source-cases.mjs";
import { cases as bootstrapCases } from "./bootstrap-cases.mjs";
import { cases as connectionOperationCases } from "./connection-operation-cases.mjs";
import { cases as discoveryCases } from "./discovery-cases.mjs";
import { cases as invalidBootstrapCases } from "./invalid-bootstrap-cases.mjs";
import { cases as invalidCredentialCases } from "./invalid-credential-cases.mjs";
import { cases as invalidDescriptorCases } from "./invalid-descriptor-cases.mjs";
import { cases as invalidEvidenceCases } from "./invalid-evidence-cases.mjs";
import { cases as protocolBoundaryCases } from "./protocol-boundary-cases.mjs";
import { cases as semanticAdmissionCases } from "./semantic-admission-cases.mjs";
import { cases as semanticBootstrapCases } from "./semantic-bootstrap-cases.mjs";
import { cases as semanticIntentCases } from "./semantic-intent-cases.mjs";
import { cases as semanticEvidenceCases1 } from "./semantic-evidence-cases-1.mjs";
import { cases as semanticEvidenceCases2 } from "./semantic-evidence-cases-2.mjs";
import { cases as semanticExecutionCases } from "./semantic-execution-cases.mjs";
import { cases as semanticAssociationCases } from "./semantic-association-cases.mjs";
import { cases as sizeLimitCases } from "./size-limit-cases.mjs";
import { cases as semanticDowngradeCases } from "./semantic-downgrade-cases.mjs";
import { cases as recoveryCases } from "./recovery-cases.mjs";
import { cases as invalidRecoveryRequestCases } from "./invalid-recovery-request-cases.mjs";
import { cases as invalidRecoveryBindingCases } from "./invalid-recovery-binding-cases.mjs";

// Clone the plain data so shared fixtures cannot couple mutations across cases.
// Keep property and case order: the serialized bytes are a frozen native input.
export const callbackCorpus = JSON.parse(JSON.stringify({
  ...metadata,
  digestVectors,
  cases: [
    ...v1OperationCases,
    ...v1SourceCases,
    ...bootstrapCases,
    ...connectionOperationCases,
    ...discoveryCases,
    ...invalidBootstrapCases,
    ...invalidCredentialCases,
    ...invalidDescriptorCases,
    ...invalidEvidenceCases,
    ...protocolBoundaryCases,
    ...semanticAdmissionCases,
    ...semanticBootstrapCases,
    ...semanticIntentCases,
    ...semanticEvidenceCases1,
    ...semanticEvidenceCases2,
    ...semanticExecutionCases,
    ...semanticAssociationCases,
    ...sizeLimitCases,
    ...semanticDowngradeCases,
    ...recoveryCases,
    ...invalidRecoveryRequestCases,
    ...invalidRecoveryBindingCases,
  ],
  framingCases,
  jcsVectors,
}));
