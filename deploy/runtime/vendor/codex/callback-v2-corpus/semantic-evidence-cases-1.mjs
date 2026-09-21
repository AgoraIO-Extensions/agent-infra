import {
  authenticatedExecutionContext,
} from "./context-fixtures.mjs";

import {
  originalReceipt,
  originalResponse,
  verifiedEvidence,
  verifiedRecordQuery,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
} from "./identity-fixtures.mjs";

import {
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-reject-outcome-descriptor-attempt-swap",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "profileRef": "connection-fixture-v1",
        "serviceRef": "connection-fixture",
        "operationNonce": "00000000-0000-4000-8000-000000000005",
        "attemptNonce": "00000000-0000-4000-8000-000000000073",
        "idempotencyKey": "00000000-0000-4000-8000-000000000005",
        "rpcRequestId": 7,
        "requestDigestVersion": "connection-request-v1",
        "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
        "method": "tools/call",
        "toolName": "execute_action",
        "actionSelector": {
          "actionId": "github.get_issue"
        }
      },
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": verifiedEvidence
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "IMMUTABLE_INTENT",
      "effect": "reject_evidence_keep_existing_fact"
    }
  },
  {
    "id": "semantic-reject-receipt-operation-nonce-swap",
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
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000074",
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
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-receipt-rpc-id-swap",
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
          "rpcRequestId": 8,
          "receivedAt": 1800000000100,
          "receipt": originalReceipt
        },
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "SAME_RESPONSE",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-missing-attempt",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-a",
            "actionVersionId": "action-version-fixture-a",
            "attemptNonces": [
              "00000000-0000-4000-8000-000000000075"
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
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-digest-mismatch",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
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
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-principal-mismatch",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-b"
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
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-actor-mismatch",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-b",
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
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-client-mismatch",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
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
            "clientId": "oauth-client-fixture-b"
          }
        },
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-consumer-mismatch",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
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
            "consumerId": "consumer-fixture-b",
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
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-record-action-version-mismatch",
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
        "originalResponse": originalResponse,
        "recordQuery": {
          "queriedAt": 1800000000200,
          "credentialRevision": "credential-fixture-r1",
          "record": {
            "callRef": "callref-fixture-a",
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-a",
            "actionVersionId": "action-version-fixture-b",
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
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  }
];
