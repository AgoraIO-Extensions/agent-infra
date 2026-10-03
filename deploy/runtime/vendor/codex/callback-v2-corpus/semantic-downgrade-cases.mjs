import {
  trustedConnectionProfile,
  userConnectionSlot,
} from "./connection-fixtures.mjs";

import {
  authenticatedRecordQuery,
  authorizationUnavailableEvidence,
  originalResponse,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
  installedIsolation,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  connectionIntent,
  connectionPermit,
  verifiedOutcome,
} from "./operation-fixtures.mjs";

import {
  connectionBootstrapRequest,
  executeActionDispatch,
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-reject-verified-association-downgrade",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000011",
      "phase": "connection-evidence",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000300,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "connectionEvidence": authorizationUnavailableEvidence
    },
    "schemaValid": true,
    "context": {
      "now": 1800000000350,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": installedIsolation,
      "executionActive": true,
      "sourceActive": true,
      "slot": userConnectionSlot,
      "nativeIdentity": connectionToolIdentity,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      },
      "pendingBootstrapRequest": connectionBootstrapRequest,
      "storedIntent": connectionIntent,
      "storedPermit": connectionPermit,
      "actualDispatch": executeActionDispatch,
      "authenticatedOriginalResponse": originalResponse,
      "independentlyAuthenticatedQuery": authenticatedRecordQuery,
      "journaledOriginalResponse": originalResponse,
      "storedTerminal": verifiedOutcome
    },
    "semanticExpected": {
      "accept": false,
      "rule": "MONOTONIC_VERIFICATION",
      "effect": "keep_verified_reference_do_not_grant_future_query_access"
    }
  }
];
