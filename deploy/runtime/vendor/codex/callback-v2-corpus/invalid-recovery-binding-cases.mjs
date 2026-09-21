import {
  originalResponse,
} from "./evidence-fixtures.mjs";

import {
  connectionCredential,
  connectionIdentity,
  connectionService,
  connectionToolIdentity,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  currentConnectionClient,
  originalConnectionOrigin,
} from "./recovery-fixtures.mjs";

import {
  connectionRecoveryRequest,
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "recovery-origin-token-forbidden",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "original": {
        "identity": connectionToolIdentity,
        "permitId": "00000000-0000-4000-8000-000000000008",
        "connectionRequest": executeActionRequest,
        "connectionOrigin": {
          "schemaVersion": 1,
          "slotId": "00000000-0000-4000-8000-000000000003",
          "originalBinding": userOriginalBinding,
          "service": connectionService,
          "connectionIdentity": connectionIdentity,
          "credential": connectionCredential
        },
        "originalResponse": originalResponse
      },
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-missing-original-response",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "original": {
        "identity": connectionToolIdentity,
        "permitId": "00000000-0000-4000-8000-000000000008",
        "connectionRequest": executeActionRequest,
        "connectionOrigin": originalConnectionOrigin
      },
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-discovery-descriptor-forbidden",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "original": {
        "identity": connectionToolIdentity,
        "permitId": "00000000-0000-4000-8000-000000000008",
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
          "toolName": "list_actions",
          "actionSelector": {
            "actionId": "github.get_issue"
          }
        },
        "connectionOrigin": originalConnectionOrigin,
        "originalResponse": originalResponse
      },
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-done-token-forbidden",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "done",
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-caller-execution-forbidden",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000042",
      "executionId": "caller-select"
    },
    "schemaValid": false
  }
];
