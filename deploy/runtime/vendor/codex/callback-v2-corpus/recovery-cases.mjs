import {
  currentConnectionClient,
  recoveryOriginal,
} from "./recovery-fixtures.mjs";

import {
  connectionRecoveryRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "recovery-request-valid",
    "layer": "schema",
    "frame": connectionRecoveryRequest,
    "schemaValid": true
  },
  {
    "id": "recovery-verify-valid",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "verify",
      "recoveryId": "00000000-0000-4000-8000-000000000043",
      "expiresAt": 1800000003000,
      "original": recoveryOriginal,
      "currentClient": currentConnectionClient
    },
    "schemaValid": true
  },
  {
    "id": "recovery-next-valid",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000042",
      "previousRecoveryId": "00000000-0000-4000-8000-000000000043"
    },
    "schemaValid": true
  },
  {
    "id": "recovery-done-valid",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "done"
    },
    "schemaValid": true
  },
  {
    "id": "recovery-unavailable-valid",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000041",
      "phase": "connection-recovery",
      "request": connectionRecoveryRequest,
      "decision": "unavailable",
      "reason": "credential_unavailable"
    },
    "schemaValid": true
  }
];
