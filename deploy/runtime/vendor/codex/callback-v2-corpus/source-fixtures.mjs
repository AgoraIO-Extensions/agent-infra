import {
  shellIdentity,
} from "./identity-fixtures.mjs";

export const childSourceReservation = {
  "reservationId": "00000000-0000-4000-8000-000000000030",
  "parent": shellIdentity,
  "parentPermitId": "00000000-0000-4000-8000-000000000008",
  "childThreadId": "child-fixture-a",
  "submissionId": "submission-fixture-a"
};

export const sourceReserveRequest = {
  "schemaVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000031",
  "phase": "source-reserve",
  "occurredAt": 1800000000000,
  "reservation": childSourceReservation
};

export const sourceNotQueuedRequest = {
  "schemaVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000035",
  "phase": "source-not-started",
  "occurredAt": 1800000000000,
  "reservation": childSourceReservation,
  "stage": "not_queued",
  "reason": "queue_closed"
};

export const sourceBindStartedRequest = {
  "schemaVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000032",
  "phase": "source-bind",
  "occurredAt": 1800000000000,
  "reservation": childSourceReservation,
  "source": {
    "threadId": "child-fixture-a",
    "turnId": "child-turn-fixture-a"
  },
  "delivery": "started"
};

export const sourceBindSteeredRequest = {
  "schemaVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000033",
  "phase": "source-bind",
  "occurredAt": 1800000000000,
  "reservation": childSourceReservation,
  "source": {
    "threadId": "child-fixture-a",
    "turnId": "child-turn-fixture-a"
  },
  "delivery": "steered"
};

export const sourceTerminalRequest = {
  "schemaVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000034",
  "phase": "source-terminal",
  "occurredAt": 1800000000000,
  "reservation": childSourceReservation,
  "source": {
    "threadId": "child-fixture-a",
    "turnId": "child-turn-fixture-a"
  },
  "nativeStatus": "completed"
};
