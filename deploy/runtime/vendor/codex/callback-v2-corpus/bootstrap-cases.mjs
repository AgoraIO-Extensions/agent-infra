import {
  applicationBootstrapPermit,
  userBootstrapPermit,
} from "./connection-fixtures.mjs";

import {
  connectionBootstrapRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "v2-bootstrap-request-before-native-session",
    "layer": "schema",
    "frame": connectionBootstrapRequest,
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-request-existing-session",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002",
      "nativeSessionRef": "thread-fixture-a"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-user-permit",
    "layer": "schema",
    "frame": userBootstrapPermit,
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-application-permit",
    "layer": "schema",
    "frame": applicationBootstrapPermit,
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-authorization_denied",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "authorization_denied"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-authorization_unavailable",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "authorization_unavailable"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-credential_unavailable",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "credential_unavailable"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-credential_expired",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "credential_expired"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-binding_mismatch",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "binding_mismatch"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-isolation_unavailable",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "isolation_unavailable"
    },
    "schemaValid": true
  },
  {
    "id": "v2-bootstrap-unavailable-profile_unavailable",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "profile_unavailable"
    },
    "schemaValid": true
  }
];
