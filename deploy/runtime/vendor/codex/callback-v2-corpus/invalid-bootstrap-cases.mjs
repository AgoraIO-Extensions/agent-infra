export const cases = [
  {
    "id": "reject-unknown-bootstrap-field",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002",
      "url": "https://attacker.example.test"
    },
    "schemaValid": false
  },
  {
    "id": "reject-model-principal-bootstrap",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002",
      "principal": {
        "kind": "user",
        "id": "platform-user-fixture-a"
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-wrong-new-schema-version",
    "layer": "schema",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002"
    },
    "schemaValid": false
  },
  {
    "id": "reject-upper-case-uuid",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002"
    },
    "schemaValid": false
  },
  {
    "id": "reject-noncanonical-uuid",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000000040008000000000000002"
    },
    "schemaValid": false
  },
  {
    "id": "reject-missing-process-nonce",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1"
    },
    "schemaValid": false
  },
  {
    "id": "reject-null-optional-session",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002",
      "nativeSessionRef": null
    },
    "schemaValid": false
  }
];
