import {
  executeActionArguments,
} from "./request-fixtures.mjs";

export const digestVectors = [
  {
    "id": "execute-action-ascii-integer",
    "preimage": {
      "version": "connection-request-v1",
      "method": "tools/call",
      "toolName": "execute_action",
      "arguments": executeActionArguments
    },
    "canonicalUtf8": "{\"arguments\":{\"actionId\":\"github.get_issue\",\"input\":{\"number\":1,\"repository\":\"fixture/private\"}},\"method\":\"tools/call\",\"toolName\":\"execute_action\",\"version\":\"connection-request-v1\"}",
    "sha256": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673"
  }
];
