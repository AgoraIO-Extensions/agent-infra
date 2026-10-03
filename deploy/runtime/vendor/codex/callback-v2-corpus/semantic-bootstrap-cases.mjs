import {
  userConnectionSlot,
} from "./connection-fixtures.mjs";

import {
  authenticatedExecutionContext,
} from "./context-fixtures.mjs";

import {
  connectionCredential,
  connectionIdentity,
  connectionService,
  executionScope,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  connectionBootstrapRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-reject-bootstrap-native-session-swap",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "profileRef": "connection-fixture-v1",
      "processNonce": "00000000-0000-4000-8000-000000000002",
      "nativeSessionRef": "thread-fixture-b"
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "SOCKET_SCOPE",
      "effect": "deny_without_credentials"
    }
  },
  {
    "id": "semantic-reject-bootstrap-original-principal-swap",
    "layer": "semantic",
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
            "id": "platform-user-fixture-b"
          },
          "scope": executionScope
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "BINDING",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-original-agent-swap",
    "layer": "semantic",
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
            "agentId": "agent-fixture-b",
            "conversationId": "conversation-fixture-a",
            "sessionGeneration": 1
          }
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "BINDING",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-response-requestid-swap",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000070",
      "phase": "connection-bootstrap",
      "request": connectionBootstrapRequest,
      "decision": "permit",
      "slot": userConnectionSlot
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "REQUEST_BINDING",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-process-nonce-swap",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000001",
      "phase": "connection-bootstrap",
      "request": {
        "schemaVersion": 2,
        "requestId": "00000000-0000-4000-8000-000000000001",
        "phase": "connection-bootstrap",
        "profileRef": "connection-fixture-v1",
        "processNonce": "00000000-0000-4000-8000-000000000071"
      },
      "decision": "permit",
      "slot": userConnectionSlot
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "REQUEST_BINDING",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-cross-generation",
    "layer": "semantic",
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
            "sessionGeneration": 2
          }
        },
        "service": connectionService,
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "BINDING",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-wrong-resource",
    "layer": "semantic",
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
          "resource": "https://connection.example.test/other"
        },
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "FIXED_PROFILE",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-wrong-issuer-origin",
    "layer": "semantic",
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
          "issuer": "https://attacker.example.test",
          "resource": "https://connection.example.test/mcp"
        },
        "connectionIdentity": connectionIdentity,
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "FIXED_PROFILE",
      "effect": "reject_slot"
    }
  },
  {
    "id": "semantic-reject-bootstrap-unconfirmed-identity-map",
    "layer": "semantic",
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
        "connectionIdentity": {
          "principal": {
            "type": "user",
            "key": "same-name-other-namespace"
          },
          "actorId": "connection-actor-fixture-a",
          "consumerId": "consumer-codex-fixture",
          "clientId": "oauth-client-fixture"
        },
        "credential": connectionCredential
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "INDEPENDENT_IDENTITY",
      "effect": "reject_slot"
    }
  }
];
