import {
  authenticatedExecutionContext,
} from "./context-fixtures.mjs";

import {
  verifiedRecordQuery,
} from "./evidence-fixtures.mjs";

import {
  connectionCredential,
  connectionIdentity,
  connectionService,
  connectionToolIdentity,
  executionScope,
} from "./identity-fixtures.mjs";

import {
  connectionBootstrapRequest,
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "reject-bootstrap-platform-scope-injection",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002",
      "scope": executionScope
    },
    "schemaValid": false
  },
  {
    "id": "reject-callref-over-public-limit",
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
            "callRef": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    "id": "reject-service-ref-over-public-limit",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "profileRef": "connection-fixture-v1",
        "serviceRef": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "operationNonce": "00000000-0000-4000-8000-000000000005",
        "attemptNonce": "00000000-0000-4000-8000-000000000006",
        "idempotencyKey": "00000000-0000-4000-8000-000000000005",
        "rpcRequestId": 7,
        "requestDigestVersion": "connection-request-v1",
        "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
        "method": "tools/call",
        "toolName": "execute_action",
        "actionSelector": {
          "actionId": "github.get_issue"
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "transport-reject-oversized-utf8-frame",
    "layer": "transport",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": {
          "principal": {
            "kind": "user",
            "id": "界".repeat(6000)
          },
          "scope": executionScope
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "FRAME_UTF8_LIMIT",
      "effect": "close_without_echo_or_persistence"
    }
  }
];
