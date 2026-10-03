import {
  authenticatedExecutionContext,
} from "./context-fixtures.mjs";

import {
  connectionToolIdentity,
} from "./identity-fixtures.mjs";

import {
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-reject-intent-source-turn-swap",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": {
        "sessionId": "thread-fixture-a",
        "turnId": "turn-fixture-b",
        "callId": "call-fixture-a",
        "attemptRef": "00000000-0000-4000-8000-000000000004",
        "toolName": "connection/execute_action"
      },
      "occurredAt": 1800000000000,
      "connectionRequest": executeActionRequest
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "SOURCE_OWNER",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-intent-agent-slot-swap",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000072",
        "profileRef": "connection-fixture-v1",
        "serviceRef": "connection-fixture",
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
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "SLOT_BINDING",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-intent-digest-not-actual-wire",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "profileRef": "connection-fixture-v1",
        "serviceRef": "connection-fixture",
        "operationNonce": "00000000-0000-4000-8000-000000000005",
        "attemptNonce": "00000000-0000-4000-8000-000000000006",
        "idempotencyKey": "00000000-0000-4000-8000-000000000005",
        "rpcRequestId": 7,
        "requestDigestVersion": "connection-request-v1",
        "requestDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "method": "tools/call",
        "toolName": "execute_action",
        "actionSelector": {
          "actionId": "github.get_issue"
        }
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "ACTUAL_REQUEST_DIGEST",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-intent-action-not-actual-wire",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "profileRef": "connection-fixture-v1",
        "serviceRef": "connection-fixture",
        "operationNonce": "00000000-0000-4000-8000-000000000005",
        "attemptNonce": "00000000-0000-4000-8000-000000000006",
        "idempotencyKey": "00000000-0000-4000-8000-000000000005",
        "rpcRequestId": 7,
        "requestDigestVersion": "connection-request-v1",
        "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
        "method": "tools/call",
        "toolName": "execute_action",
        "actionSelector": {
          "actionId": "github.create_issue"
        }
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "ACTUAL_SELECTOR",
      "effect": "deny_dispatch"
    }
  }
];
