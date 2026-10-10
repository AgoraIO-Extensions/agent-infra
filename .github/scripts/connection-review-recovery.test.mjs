import assert from "node:assert/strict";
import test from "node:test";
import { eligible, evidence, conclusion } from "./connection-review-recovery.ts";
const head="a".repeat(40);
const repository="AgoraIO-Extensions/agent-infra";
const pr={number:1688,merged:true,draft:false,base:{ref:"connection"},head:{sha:head,repo:{full_name:repository}}};
const event={sender:{type:"User"},comment:{body:"/review",author_association:"MEMBER"},issue:{number:1688,pull_request:{}}};
const started="2026-10-10T07:00:00Z";
const report=(sha=head)=>({id:1,user:{type:"Bot",login:"github-actions[bot]"},updated_at:"2026-10-10T07:01:00Z",body:`## PR Reviewer Guide\n<!-- pr-agent-review-state:v1\n${JSON.stringify({last_run:{head_sha:sha,kind:"full",complete:true}})}\n-->`});
test("merged recovery requires the exact authorized command, repository and target",()=>{
 assert.equal(eligible(event,pr,repository),true);
 for(const changed of [{...event,sender:{type:"Bot"}},{...event,comment:{...event.comment,body:"/review extra"}},{...event,comment:{...event.comment,author_association:"NONE"}},{...event,issue:{number:12,pull_request:{}}}])assert.equal(eligible(changed,pr,repository),false);
 for(const changed of [{...pr,merged:false},{...pr,draft:true},{...pr,base:{ref:"main"}},{...pr,head:{...pr.head,repo:{full_name:"other/fork"}}}])assert.equal(eligible(event,changed,repository),false);
});
test("only a fresh full trusted Bot result for the captured head counts",()=>{
 assert.ok(evidence([report()],head,started,{}));
 for(const comment of [report("b".repeat(40)),{...report(),user:{type:"User",login:"github-actions[bot]"}},{...report(),user:{type:"Bot",login:"other[bot]"}},{...report(),updated_at:"2026-10-10T06:59:00Z"},{...report(),body:"Review failed"},{...report(),body:report().body.replace('"complete":true','"complete":false')},{...report(),body:report().body+report().body}])assert.equal(evidence([comment],head,started,{}),null);
 assert.equal(evidence([report()],head,"invalid",{}),null);
});
test("analysis failure, skip, absent output and head changes cannot publish success",()=>{
 assert.equal(conclusion("success",pr,head,[report()],started,{}),"success");
 for(const status of ["failure","cancelled","skipped",""])assert.equal(conclusion(status,pr,head,[report()],started,{}),"failure");
 assert.equal(conclusion("success",pr,head,[],started,{}),"failure");
 assert.equal(conclusion("success",{...pr,head:{...pr.head,sha:"b".repeat(40)}},head,[report()],started,{}),"failure");
});

test("an edited unchanged report cannot be reused",async()=>{
 const {createHash}=await import("node:crypto");
 const unchanged=report();
 assert.equal(evidence([unchanged],head,started,{"1":createHash("sha256").update(unchanged.body).digest("hex")}),null);
});
test("publisher writes only the captured head and fails closed on a skipped model",async(t)=>{
 const {runControl}=await import("./connection-review-recovery.ts");
 const original={...process.env};
 const originalArg=process.argv[2];
 const writes=[];
 try{
  Object.assign(process.env,{GITHUB_REPOSITORY:repository,GITHUB_TOKEN:"test-only-token",GITHUB_RUN_ID:"123",REVIEW_PR:"1688",REVIEW_HEAD:head,REVIEW_STARTED:started,REVIEW_BEFORE:"{}",REVIEW_RESULT:"success"});
  process.argv[2]="publish";
  t.mock.method(globalThis,"fetch",async(url,options)=>{
   assert.equal(new URL(url).origin,"https://api.github.com");
   if(options?.method==="POST"){writes.push(JSON.parse(options.body));return Response.json({id:123});}
   return Response.json(String(url).includes("/comments?")?[report()]:pr);
  });
  await runControl();
  assert.equal(writes[0].head_sha,head);assert.equal(writes[0].conclusion,"success");
  process.env.REVIEW_RESULT="skipped";
  await assert.rejects(()=>runControl(),/recovery failed/);
  assert.equal(writes[1].conclusion,"failure");
  process.env.REVIEW_HEAD="b".repeat(40);
  await assert.rejects(()=>runControl(),/target changed/);
  assert.equal(writes.length,2);
 }finally{
  for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];
  Object.assign(process.env,original);process.argv[2]=originalArg;
 }
});
test("a queued recovery cannot reuse a previous run's output after preparation",async()=>{
 const {createHash}=await import("node:crypto");
 const fromPreviousRun=report();
 const capturedBefore={"1":createHash("sha256").update(fromPreviousRun.body).digest("hex")};
 assert.equal(evidence([fromPreviousRun],head,started,capturedBefore),null);
});
