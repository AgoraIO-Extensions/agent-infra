export const installedIsolation = {
  "actualInstalledState": "linux-aarch64-memory-filter",
  "nodeBridgeProtected": true,
  "credentialLaneEnabled": true
};

export const connectionCredential = {
  "revision": "credential-fixture-r1",
  "expiresAt": 1800000030000,
  "accessToken": "FAKE-TEST-ONLY-NOT-A-CREDENTIAL"
};

export const connectionService = {
  "serviceRef": "connection-fixture",
  "issuer": "https://connection.example.test",
  "resource": "https://connection.example.test/mcp"
};

export const executionScope = {
  "executionId": "execution-fixture-a",
  "agentId": "agent-fixture-a",
  "conversationId": "conversation-fixture-a",
  "sessionGeneration": 1
};

export const shellIdentity = {
  "sessionId": "thread-fixture-a",
  "turnId": "turn-fixture-a",
  "callId": "call-fixture-a",
  "attemptRef": "00000000-0000-4000-8000-000000000004",
  "toolName": "shell"
};

export const connectionIdentity = {
  "principal": {
    "type": "user",
    "key": "connection-user-fixture-a"
  },
  "actorId": "connection-actor-fixture-a",
  "consumerId": "consumer-codex-fixture",
  "clientId": "oauth-client-fixture"
};

export const connectionToolIdentity = {
  "sessionId": "thread-fixture-a",
  "turnId": "turn-fixture-a",
  "callId": "call-fixture-a",
  "attemptRef": "00000000-0000-4000-8000-000000000004",
  "toolName": "connection/execute_action"
};

export const userOriginalBinding = {
  "principal": {
    "kind": "user",
    "id": "platform-user-fixture-a"
  },
  "scope": executionScope
};

export const applicationOriginalBinding = {
  "principal": {
    "kind": "application",
    "id": "platform-application-fixture-a"
  },
  "scope": executionScope
};
