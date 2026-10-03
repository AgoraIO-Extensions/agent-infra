import {
  verifiedEvidence,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
  shellIdentity,
} from "./identity-fixtures.mjs";

import {
  executeActionRequest,
  getActionGuideRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "reject-v1-new-field-injection",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": shellIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": executeActionRequest
    },
    "schemaValid": false
  },
  {
    "id": "reject-v1-null-parent-attempt",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": {
        "sessionId": "thread-fixture-a",
        "turnId": "turn-fixture-a",
        "callId": "call-fixture-a",
        "attemptRef": "00000000-0000-4000-8000-000000000004",
        "toolName": "shell",
        "parentAttemptRef": null
      },
      "occurredAt": 1800000000000
    },
    "schemaValid": false
  },
  {
    "id": "reject-v1-unknown-source-field",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000031",
      "phase": "source-reserve",
      "occurredAt": 1800000000000,
      "reservation": {
        "reservationId": "00000000-0000-4000-8000-000000000030",
        "parent": shellIdentity,
        "parentPermitId": "00000000-0000-4000-8000-000000000008",
        "childThreadId": "child-fixture-a",
        "submissionId": "submission-fixture-a",
        "credential": "FAKE-TOKEN"
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-discovery-action-selector",
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
        "serviceRef": "connection-fixture",
        "operationNonce": "00000000-0000-4000-8000-000000000005",
        "attemptNonce": "00000000-0000-4000-8000-000000000006",
        "idempotencyKey": "00000000-0000-4000-8000-000000000005",
        "rpcRequestId": 7,
        "requestDigestVersion": "connection-request-v1",
        "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
        "method": "tools/call",
        "toolName": "list_apps",
        "actionSelector": {
          "actionId": "github.get_issue"
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-guide-provider-evidence",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": getActionGuideRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": verifiedEvidence
    },
    "schemaValid": false
  },
  {
    "id": "v2-connection-deny",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "decision": "deny",
      "connectionRequest": executeActionRequest,
      "reason": "authorization_denied"
    },
    "schemaValid": true
  }
];
