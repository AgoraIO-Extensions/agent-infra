import {
  applicationOriginalBinding,
  connectionCredential,
  connectionIdentity,
  connectionService,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  connectionBootstrapRequest,
} from "./request-fixtures.mjs";

export const trustedConnectionProfile = {
  "profileRef": "connection-fixture-v1",
  "service": connectionService,
  "mcpEndpoint": "https://connection.example.test/mcp",
  "identityEndpoint": "https://connection.example.test/api/client/identity",
  "callsPathPrefix": "https://connection.example.test/api/client/calls/",
  "connectionIdentity": connectionIdentity
};

export const userConnectionSlot = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "originalBinding": userOriginalBinding,
  "service": connectionService,
  "connectionIdentity": connectionIdentity,
  "credential": connectionCredential
};

export const applicationConnectionSlot = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "originalBinding": applicationOriginalBinding,
  "service": connectionService,
  "connectionIdentity": {
    "principal": {
      "type": "application",
      "key": "connection-application-fixture-a"
    },
    "actorId": "connection-actor-fixture-a",
    "consumerId": "consumer-codex-fixture",
    "clientId": "oauth-client-fixture"
  },
  "credential": connectionCredential
};

export const userBootstrapPermit = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000001",
  "phase": "connection-bootstrap",
  "request": connectionBootstrapRequest,
  "decision": "permit",
  "slot": userConnectionSlot
};

export const applicationBootstrapPermit = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000001",
  "phase": "connection-bootstrap",
  "request": connectionBootstrapRequest,
  "decision": "permit",
  "slot": applicationConnectionSlot
};
