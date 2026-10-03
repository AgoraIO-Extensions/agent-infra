import {
  userConnectionSlot,
} from "./connection-fixtures.mjs";

import {
  connectionCredential,
  connectionIdentity,
  connectionService,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  connectionBootstrapRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "reject-zero-generation",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": {
          "principal": {
            "kind": "user",
            "id": "platform-user-fixture-a"
          },
          "scope": {
            "executionId": "execution-fixture-a",
            "agentId": "agent-fixture-a",
            "conversationId": "conversation-fixture-a",
            "sessionGeneration": 0
          }
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-oversized-scope-id",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": {
          "principal": {
            "kind": "user",
            "id": "platform-user-fixture-a"
          },
          "scope": {
            "executionId": "execution-fixture-a",
            "agentId": "a".repeat(257),
            "conversationId": "conversation-fixture-a",
            "sessionGeneration": 1
          }
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-control-character-id",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": {
          "principal": {
            "kind": "user",
            "id": "platform-user-fixture-a"
          },
          "scope": {
            "executionId": "execution-fixture-a",
            "agentId": "a\u0000b",
            "conversationId": "conversation-fixture-a",
            "sessionGeneration": 1
          }
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-null-token",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": {
          "revision": "credential-fixture-r1",
          "expiresAt": 1800000030000,
          "accessToken": null
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-oversized-token",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": {
          "revision": "credential-fixture-r1",
          "expiresAt": 1800000030000,
          "accessToken": "X".repeat(8193)
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-token-newline",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": {
          "revision": "credential-fixture-r1",
          "expiresAt": 1800000030000,
          "accessToken": "FAKE\nTOKEN"
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-refresh-token-injection",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": {
          "revision": "credential-fixture-r1",
          "expiresAt": 1800000030000,
          "accessToken": "FAKE-TEST-ONLY-NOT-A-CREDENTIAL",
          "refreshToken": "FAKE-REFRESH"
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-provider-token-injection",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential,
        "providerToken": "FAKE-PROVIDER"
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-platform-token-injection",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential,
        "platformGrant": "FAKE-PLATFORM"
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-arbitrary-headers-injection",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential,
        "headers": {
          "Authorization": "FAKE"
        }
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-unavailable-with-token-slot",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "unavailable",
      "reason": "credential_unavailable",
      "slot": userConnectionSlot
    },
    "schemaValid": false
  },
  {
    "id": "reject-permit-missing-slot",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit"
    },
    "schemaValid": false
  },
  {
    "id": "reject-permit-with-reason",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": userConnectionSlot,
      "reason": "credential_unavailable"
    },
    "schemaValid": false
  },
  {
    "id": "reject-http-issuer",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": {
          "serviceRef": "connection-fixture",
          "issuer": "http://connection.example.test",
          "resource": "https://connection.example.test/mcp"
        },
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": false
  },
  {
    "id": "reject-userinfo-resource",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "originalBinding": userOriginalBinding,
        "service": {
          "serviceRef": "connection-fixture",
          "issuer": "https://connection.example.test",
          "resource": "https://user:password@connection.example.test/mcp"
        },
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": false
  }
];
