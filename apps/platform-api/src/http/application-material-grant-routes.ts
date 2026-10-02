import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import { ApplicationMaterialGrantPrincipalTypeV1Schema, ApplicationMaterialGrantRequestV1Schema, ApplicationMaterialGrantRevokeRequestV1Schema, ApplicationMaterialGrantMetadataV1Schema, ApplicationMaterialGrantResponseV1Schema } from "@agent-infra/contracts/pilot";
import type { ApplicationMaterialGrantUseCaseV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import type { Context } from "hono";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
export interface ApplicationMaterialGrantRouteDependencies { readonly identity: IdentityAdapter; readonly grants: ApplicationMaterialGrantUseCaseV1; }
export function registerApplicationMaterialGrantRoutes(app: Hono, dependencies: ApplicationMaterialGrantRouteDependencies): void {
  async function handle(context: Context, operation: "grant" | "revoke" | "read"): Promise<Response> {
    const metadata = requestMetadata(context.req.raw); context.header("Cache-Control", "no-store"); context.header("Referrer-Policy", "no-referrer");
    try {
      if (context.req.raw.headers.has("Authorization")) throw new HttpProtocolError("AUTHENTICATION_REQUIRED", metadata.traceId);
      const identity = await resolveIdentity(dependencies.identity, context.req.raw, metadata.traceId);
      const applicationIdResult = OpaqueIdV1Schema.safeParse(context.req.param("applicationId"));
      if (!applicationIdResult.success) throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
      const applicationId = applicationIdResult.data;
      let principalType = context.req.param("principalType"); let principalId = context.req.param("principalId"); let expectedRevision: string | undefined;
      if (operation === "grant") { const parsed = await parseJson(context.req.raw, ApplicationMaterialGrantRequestV1Schema, metadata.traceId); principalType = parsed.value.principalType; principalId = parsed.value.principalId; }
      if (operation === "revoke") { const parsed = await parseJson(context.req.raw, ApplicationMaterialGrantRevokeRequestV1Schema, metadata.traceId); expectedRevision = parsed.value.expectedRevision; }
      if (!ApplicationMaterialGrantPrincipalTypeV1Schema.safeParse(principalType).success || !OpaqueIdV1Schema.safeParse(principalId).success) throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
      const request = { requestId: metadata.requestId, traceId: metadata.traceId, actor: { userId: identity.userId, accountStatus: identity.accountStatus, isSystemAdmin: identity.roles.includes("system_admin"), authorizationRevision: identity.authorizationRevision }, applicationId, principalType: principalType as "user" | "application", principalId, ...(expectedRevision ? { expectedRevision } : {}) };
      const result = operation === "grant" ? await dependencies.grants.grant(request) : operation === "revoke" ? await dependencies.grants.revoke(request) : { metadata: await dependencies.grants.read(request), replayed: false };
      if (operation === "read" && !result.metadata) throw new HttpProtocolError("NOT_FOUND", metadata.traceId);
      const response = ApplicationMaterialGrantResponseV1Schema.safeParse({ metadata: result.metadata, replayed: result.replayed });
      if (!response.success) throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
      return context.json(response.data, operation === "grant" ? 201 : 200);
    } catch (error) { const protocol = mapCoreError(error, metadata.traceId); return context.json(protocol.body, protocol.status); }
  }
  app.post("/api/v2/applications/:applicationId/material-grant", (c) => handle(c, "grant"));
  app.patch("/api/v2/applications/:applicationId/material-grant/:principalType/:principalId", (c) => handle(c, "revoke"));
  app.get("/api/v2/applications/:applicationId/material-grant/:principalType/:principalId", (c) => handle(c, "read"));
}
