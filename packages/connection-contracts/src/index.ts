import document from "../openapi.json" with { type: "json" };

export const connectionBrowserOpenApi = document;
export * from "./browser-schemas";
export * from "./generated";
export { client } from "./generated/client.gen";
