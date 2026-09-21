import {
  trustedConnectionProfile,
  userConnectionSlot,
} from "./connection-fixtures.mjs";

import {
  authenticatedExecutionContext,
  lostResponseContext,
  metadataUpdateContext,
} from "./context-fixtures.mjs";

import {
  authenticatedRecordQuery,
  differentRecordQuery,
  originalResponse,
  recordUnavailableEvidence,
  verifiedRecordQuery,
} from "./evidence-fixtures.mjs";

import {
  connectionCredential,
  connectionIdentity,
  connectionService,
  connectionToolIdentity,
  installedIsolation,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  connectionEvidenceUpdate,
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
    "id": "semantic-reject-control-grant-query-identity",
    "layer": "semantic",
    "frame": verifiedOutcome,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
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
      "independentlyAuthenticatedQuery": {
        "origin": "https://connection.example.test",
        "path": "/api/client/calls/callref-fixture-a",
        "identity": {
          "principal": {
            "type": "user",
            "key": "controller-not-original-user"
          },
          "actorId": "connection-actor-fixture-a",
          "consumerId": "consumer-codex-fixture",
          "clientId": "oauth-client-fixture"
        },
        "query": verifiedRecordQuery
      },
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "INDEPENDENT_CURRENT_QUERY_AUTH",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-response-provided-record-origin",
    "layer": "semantic",
    "frame": verifiedOutcome,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
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
      "independentlyAuthenticatedQuery": {
        "origin": "https://attacker.example.test",
        "path": "/api/client/calls/callref-fixture-a",
        "identity": connectionIdentity,
        "query": verifiedRecordQuery
      },
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "FIXED_PROFILE",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-real-callref-cross-execution-graft",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": {
        "verification": "verified",
        "originalResponse": {
          "rpcRequestId": 7,
          "receivedAt": 1800000000100,
          "receipt": {
            "callRef": "real-same-principal-other-execution-call",
            "operationNonce": "00000000-0000-4000-8000-000000000078",
            "attemptNonce": "00000000-0000-4000-8000-000000000006",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-a",
            "actionVersionId": "action-version-fixture-a"
          }
        },
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "real-same-principal-other-execution-call",
            "operationNonce": "00000000-0000-4000-8000-000000000078",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-a",
            "actionVersionId": "action-version-fixture-a",
            "attemptNonces": [
              "00000000-0000-4000-8000-000000000006"
            ],
            "consumerId": "consumer-codex-fixture",
            "clientId": "oauth-client-fixture"
          }
        },
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "SAME_RESPONSE_AND_IMMUTABLE_INTENT",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-lost-response-nonce-lookup-upgrade",
    "layer": "semantic",
    "frame": verifiedOutcome,
    "schemaValid": true,
    "context": lostResponseContext,
    "semanticExpected": {
      "accept": false,
      "rule": "ORIGINAL_RESPONSE_REQUIRED",
      "effect": "remain_unverified_without_dispatch"
    }
  },
  {
    "id": "semantic-reject-metadata-callref-replacement",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000011",
      "phase": "connection-evidence",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000300,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "connectionEvidence": {
        "verification": "verified",
        "originalResponse": {
          "rpcRequestId": 7,
          "receivedAt": 1800000000100,
          "receipt": {
            "callRef": "callref-fixture-b",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "attemptNonce": "00000000-0000-4000-8000-000000000006",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-a",
            "actionVersionId": "action-version-fixture-a"
          }
        },
        "recordQuery": differentRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": true,
    "context": metadataUpdateContext,
    "semanticExpected": {
      "accept": false,
      "rule": "METADATA_ONLY",
      "effect": "keep_original_reference_and_counters"
    }
  },
  {
    "id": "semantic-reject-metadata-attempt-replacement",
    "layer": "semantic",
    "frame": connectionEvidenceUpdate,
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
      "storedTerminal": {
        "schemaVersion": 2,
        "requestId": "00000000-0000-4000-8000-000000000010",
        "phase": "outcome",
        "identity": {
          "sessionId": "thread-fixture-a",
          "turnId": "turn-fixture-a",
          "callId": "call-fixture-a",
          "attemptRef": "00000000-0000-4000-8000-000000000079",
          "toolName": "connection/execute_action"
        },
        "occurredAt": 1800000000210,
        "connectionRequest": executeActionRequest,
        "permitId": "00000000-0000-4000-8000-000000000008",
        "outcome": "completed",
        "connectionEvidence": recordUnavailableEvidence
      }
    },
    "semanticExpected": {
      "accept": false,
      "rule": "METADATA_ONLY",
      "effect": "keep_original_attempt_and_counters"
    }
  },
  {
    "id": "semantic-reject-user-application-identity-fallback",
    "layer": "semantic",
    "frame": connectionIntent,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": installedIsolation,
      "executionActive": true,
      "sourceActive": true,
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": {
          "principal": {
            "type": "application",
            "key": "connection-user-fixture-a"
          },
          "actorId": "connection-actor-fixture-a",
          "consumerId": "consumer-codex-fixture",
          "clientId": "oauth-client-fixture"
        },
        "credential": connectionCredential
      },
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
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "INDEPENDENT_IDENTITY",
      "effect": "deny_dispatch"
    }
  }
];
