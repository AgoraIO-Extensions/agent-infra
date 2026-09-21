import {
  shellIdentity,
} from "./identity-fixtures.mjs";

export const cases = [
  {
    "id": "v1-operation-intent",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": shellIdentity,
      "occurredAt": 1800000000000
    },
    "schemaValid": true
  },
  {
    "id": "v1-operation-permit",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": shellIdentity,
      "decision": "permit",
      "permitId": "00000000-0000-4000-8000-000000000008",
      "expiresAt": 1800000005000,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      }
    },
    "schemaValid": true
  },
  {
    "id": "v1-operation-started",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "started",
      "identity": shellIdentity,
      "occurredAt": 1800000000000,
      "permitId": "00000000-0000-4000-8000-000000000008"
    },
    "schemaValid": true
  },
  {
    "id": "v1-operation-outcome",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "outcome",
      "identity": shellIdentity,
      "occurredAt": 1800000000000,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed"
    },
    "schemaValid": true
  }
];
