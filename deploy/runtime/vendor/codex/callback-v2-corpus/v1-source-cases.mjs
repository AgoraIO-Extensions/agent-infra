import {
  sourceBindStartedRequest,
  sourceBindSteeredRequest,
  sourceNotQueuedRequest,
  sourceReserveRequest,
  sourceTerminalRequest,
} from "./source-fixtures.mjs";

export const cases = [
  {
    "id": "v1-source-reserve-request",
    "layer": "schema",
    "frame": sourceReserveRequest,
    "schemaValid": true
  },
  {
    "id": "v1-source-reserve-request-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000031",
      "phase": "source-reserve",
      "request": sourceReserveRequest,
      "decision": "ack",
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      }
    },
    "schemaValid": true
  },
  {
    "id": "v1-source-bind-started",
    "layer": "schema",
    "frame": sourceBindStartedRequest,
    "schemaValid": true
  },
  {
    "id": "v1-source-bind-started-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000032",
      "phase": "source-bind",
      "request": sourceBindStartedRequest,
      "decision": "ack",
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      }
    },
    "schemaValid": true
  },
  {
    "id": "v1-source-bind-steered",
    "layer": "schema",
    "frame": sourceBindSteeredRequest,
    "schemaValid": true
  },
  {
    "id": "v1-source-bind-steered-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000033",
      "phase": "source-bind",
      "request": sourceBindSteeredRequest,
      "decision": "ack",
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      }
    },
    "schemaValid": true
  },
  {
    "id": "v1-source-terminal-request",
    "layer": "schema",
    "frame": sourceTerminalRequest,
    "schemaValid": true
  },
  {
    "id": "v1-source-terminal-request-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000034",
      "phase": "source-terminal",
      "request": sourceTerminalRequest,
      "decision": "ack"
    },
    "schemaValid": true
  },
  {
    "id": "v1-source-not-started-not_queued",
    "layer": "schema",
    "frame": sourceNotQueuedRequest,
    "schemaValid": true
  },
  {
    "id": "v1-source-not-started-not_queued-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000035",
      "phase": "source-not-started",
      "request": sourceNotQueuedRequest,
      "decision": "ack"
    },
    "schemaValid": true
  },
  {
    "id": "v1-source-reserve-deny",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000031",
      "phase": "source-reserve",
      "request": sourceReserveRequest,
      "decision": "deny",
      "reason": "authorization_denied"
    },
    "schemaValid": true
  },
  {
    "id": "v1-source-bind-deny",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000032",
      "phase": "source-bind",
      "request": sourceBindStartedRequest,
      "decision": "deny",
      "reason": "authorization_denied"
    },
    "schemaValid": true
  }
];
