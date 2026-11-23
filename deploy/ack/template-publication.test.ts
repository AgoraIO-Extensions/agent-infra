import { expect, it } from "vitest";
import { runTemplatePublicationOperatorV1 } from "./template-publication.ts";

const result={schemaVersion:1,publicationId:"release-test",status:"active",counts:{applied:0,pending:0,unknown:0,rejected:0},targets:[],nextCursor:null};
it("uses the administrator only to prepare and the authenticated service only to activate the fixed publication",async()=>{
	const requests:{actor:string;request:Request}[]=[];
	const input={publicationId:"release-test",origin:"https://publication.test",administratorRequest:async(request:Request)=>{requests.push({actor:"administrator",request});return Response.json(result,{status:202});},serviceRequest:async(request:Request)=>{requests.push({actor:"service",request});return Response.json(result,{status:202});}};
	await runTemplatePublicationOperatorV1("prepare",input);await runTemplatePublicationOperatorV1("activate",input);
	expect(requests.map((r)=>r.actor)).toEqual(["administrator","service"]);
	expect(await requests[0]!.request.json()).toEqual({schemaVersion:1});
	expect(requests[1]!.request.url).toBe("https://publication.test/internal/ops/standard-template-releases/release-test/activate-automatic");
});
it("returns a fixed error without carrying private transport messages or causes",async()=>{
	const request=async()=>{throw new Error("synthetic-private-credential-canary");};
	const error=await runTemplatePublicationOperatorV1("prepare",{publicationId:"release-test",origin:"https://publication.test",administratorRequest:request,serviceRequest:request}).catch((error:unknown)=>error);
	expect(error).toBeInstanceOf(Error);expect((error as Error).message).toBe("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");expect(Object.hasOwn(error as object,"cause")).toBe(false);
});
