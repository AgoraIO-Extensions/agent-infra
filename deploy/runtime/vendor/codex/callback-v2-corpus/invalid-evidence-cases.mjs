import {
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
    "id": "reject-intent-with-evidence",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": executeActionRequest,
      "connectionEvidence": verifiedEvidence
    },
    "schemaValid": false
  },
  {
    "id": "reject-started-with-outcome",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000009",
      "phase": "started",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000001,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed"
    },
    "schemaValid": false
  },
  {
    "id": "reject-completed-with-reason",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": verifiedEvidence,
      "reason": "execution_failed"
    },
    "schemaValid": false
  },
  {
    "id": "reject-verified-without-original-receipt",
    "layer": "schema",
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
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-verified-without-query",
    "layer": "schema",
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
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-verified-without-time",
    "layer": "schema",
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
        "recordQuery": verifiedRecordQuery
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-verified-with-unverified-reason",
    "layer": "schema",
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
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000000200,
        "reason": "receipt_missing"
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-unverified-without-reason",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "unknown",
      "connectionEvidence": {
        "verification": "unverified"
      },
      "reason": "result_unconfirmed"
    },
    "schemaValid": false
  },
  {
    "id": "reject-unverified-with-verified-time",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "unknown",
      "connectionEvidence": {
        "verification": "unverified",
        "reason": "response_unconfirmed",
        "verifiedAt": 1800000000200
      },
      "reason": "result_unconfirmed"
    },
    "schemaValid": false
  },
  {
    "id": "reject-provider-result-in-record",
    "layer": "schema",
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
            "clientId": "oauth-client-fixture",
            "result": {
              "body": "FAKE-PROVIDER-BODY"
            }
          }
        },
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-token-in-receipt",
    "layer": "schema",
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
            "operationNonce": "00000000-0000-4000-8000-000000000005",
            "attemptNonce": "00000000-0000-4000-8000-000000000006",
            "requestDigestVersion": "connection-request-v1",
            "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
            "principal": {
              "type": "user",
              "key": "connection-user-fixture-a"
            },
            "actorId": "connection-actor-fixture-a",
            "actionVersionId": "action-version-fixture-a",
            "accessToken": "FAKE-TOKEN"
          }
        },
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-null-optional-query",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "unknown",
      "connectionEvidence": {
        "verification": "unverified",
        "reason": "response_unconfirmed",
        "recordQuery": null
      },
      "reason": "result_unconfirmed"
    },
    "schemaValid": false
  },
  {
    "id": "reject-callref-url",
    "layer": "schema",
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
            "callRef": "https://attacker.example.test/call",
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
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-empty-attempt-set",
    "layer": "schema",
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
            "attemptNonces": [],
            "consumerId": "consumer-codex-fixture",
            "clientId": "oauth-client-fixture"
          }
        },
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-duplicate-attempt-set",
    "layer": "schema",
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
              "00000000-0000-4000-8000-000000000006",
              "00000000-0000-4000-8000-000000000006"
            ],
            "consumerId": "consumer-codex-fixture",
            "clientId": "oauth-client-fixture"
          }
        },
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-unsafe-integer-timestamp",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 9007199254740992,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": verifiedEvidence
    },
    "schemaValid": false
  },
  {
    "id": "reject-metadata-update-with-outcome",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000011",
      "phase": "connection-evidence",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000300,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "connectionEvidence": verifiedEvidence,
      "outcome": "completed"
    },
    "schemaValid": false
  },
  {
    "id": "reject-metadata-update-with-new-start-time",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000011",
      "phase": "connection-evidence",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000300,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "connectionEvidence": verifiedEvidence,
      "startedAt": 1800000000000
    },
    "schemaValid": false
  }
];
