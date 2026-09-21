import {
  currentConnectionClient,
  recoveryOriginal,
} from "./recovery-fixtures.mjs";

import {
  connectionRecoveryRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "recovery-verify-missing-request",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "original": recoveryOriginal,
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-verify-missing-recoveryId",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "expiresAt": 1800000003000,
      "original": recoveryOriginal,
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-verify-missing-expiresAt",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "original": recoveryOriginal,
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-verify-missing-original",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "currentClient": currentConnectionClient
    },
    "schemaValid": false
  },
  {
    "id": "recovery-verify-missing-currentClient",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "original": recoveryOriginal
    },
    "schemaValid": false
  },
  {
    "id": "recovery-request-null-previousRecoveryId",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000042",
      "previousRecoveryId": null
    },
    "schemaValid": false
  },
  {
    "id": "recovery-request-null-processNonce",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "profileRef": "connection-fixture-v1",
      "processNonce": null
    },
    "schemaValid": false
  },
  {
    "id": "recovery-request-null-profileRef",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "profileRef": null,
      "processNonce": "00000000-0000-4000-8000-000000000042"
    },
    "schemaValid": false
  }
];
