import {
  originalResponse,
} from "./evidence-fixtures.mjs";

import {
  connectionCredential,
  connectionIdentity,
  connectionService,
  connectionToolIdentity,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  executeActionRequest,
} from "./request-fixtures.mjs";

export const originalConnectionOrigin = {
  "schemaVersion": 1,
  "slotId": "00000000-0000-4000-8000-000000000003",
  "originalBinding": userOriginalBinding,
  "service": connectionService,
  "connectionIdentity": connectionIdentity
};

export const currentConnectionClient = {
  "originalBinding": userOriginalBinding,
  "service": connectionService,
  "connectionIdentity": connectionIdentity,
  "credential": connectionCredential
};

export const recoveryOriginal = {
  "identity": connectionToolIdentity,
  "permitId": "00000000-0000-4000-8000-000000000008",
  "connectionRequest": executeActionRequest,
  "connectionOrigin": originalConnectionOrigin,
  "originalResponse": originalResponse
};
