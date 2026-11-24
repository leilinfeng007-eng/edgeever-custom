import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";
import { createMemoRecord, getMemoDetail, updateMemoRecord, moveMemosRecord } from "../notes/memo-service.ts";
import { createAttachmentResource } from "../attachments/resource-service.ts";
import { createCompanionTools, emptyCompanionAgentSession, parseCompanionAgentSession, companionToolDefinitions } from "./companion-agent-tools.ts";
import { notebookClassificationChoice, processInboxClassification } from "./inbox-classification.ts";
import { beginCompanionTurn, checkpointCompanionTurn } from "./companion-service.ts";
import { registerCompanionRoutes } from "./companion-routes.ts";

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "edgeever-assistant-"));
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const name of readdirSync("migrations").filter(n => n.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
    const scope = { workspaceId: "ws_assistant", ownerId: "assistant-owner" };
    sqlite.query("INSERT INTO workspaces(id,name) VALUES (?, 'Assistant')").run(scope.workspaceId);
    for (const [id,slug] of [["inbox","inbox"],["projects",null]]) sqlite.query("INSERT INTO notebooks(id,workspace_id,name,slug) VALUES (?,?,?,?)").run(id,scope.workspaceId,id,slug);
    const auth = { ...scope, kind:"user", actorType:"user", actorId:scope.ownerId, scopes:[], role:"owner", username:"owner", displayName:null };
    const actor = { actorType:"user", actorId:scope.ownerId };
    const env = { storage:createSelfHostedStorageAdapter(sqlite,dir), EDGE_EVER_RUNTIME:"self-hosted-bun" };
    const context = {env,get:()=>auth};
    const db=env.storage.db;
    const input={id:crypto.randomUUID(),threadId:crypto.randomUUID(),message:"Organize these notes",allowNotes:true,useMemory:false,locale:"zh-CN"};
    const create = (body="原始正文",notebookId="projects")=>createMemoRecord(db,scope.workspaceId,{notebookId,title:"记录",contentMarkdown:body},actor,"owner");
    const tools = (session=emptyCompanionAgentSession(),override={})=>createCompanionTools({db,scope,context,input:{...input,...override},session,sources:[],signal:new AbortController().signal,assertActive:async()=>{}});
    const app=new Hono(); app.use("*",async(c,next)=>{c.set("auth",c.req.header("x-other")?{...auth,actorId:"other"}:auth);await next();});
    registerCompanionRoutes(app,{isDemoMode:()=>false});
    const request=(turnId,body,headers={})=>app.request(`/api/v1/companion/turns/${turnId}/save-note`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)},env);
    await run({sqlite,scope,auth,actor,env,context,db,input,create,tools,request,app});
  } finally { sqlite.close(); rmSync(dir,{recursive:true,force:true}); }
}

test("long note pages persist across tool requests and require contiguous full reading before editing",()=>fixture(async f=>{
  const body="原文".repeat(9000); const memo=await f.create(body);
  const session=emptyCompanionAgentSession(); const a=f.tools(session);
  const page=await a.get_memo.execute({memoId:memo.id});
  expect(page).toMatchObject({nextOffset:12000,truncated:true,totalCharacters:18000});
  await expect(a.get_memo.execute({memoId:memo.id,offset:16000})).rejects.toMatchObject({code:"companion_unread_page"});
  await expect(a.update_memo.execute({memoId:memo.id,contentMarkdown:"incomplete replacement"})).rejects.toMatchObject({code:"companion_action_unread"});
  const b=f.tools(parseCompanionAgentSession(JSON.parse(JSON.stringify(session))));
  const tail=await b.get_memo.execute({memoId:memo.id,offset:page.nextOffset});
  expect(page.content+tail.content).toBe(body); expect(tail).toMatchObject({nextOffset:null,truncated:false});
  expect(await b.update_memo.execute({memoId:memo.id,contentMarkdown:body+"\n补充"})).toMatchObject({applied:true});
  const updated=await getMemoDetail(f.db,f.scope.workspaceId,memo.id);
  expect(updated.contentMarkdown).toBe(body+"\n补充"); expect(updated.notebookId).toBe("projects");
}));

test("built-in tools read real image bytes and every Word page with workspace and parent-note isolation",()=>fixture(async f=>{
  const note=await f.create(); const other=await f.create();
  const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const text="Word 附件内容。".repeat(1800);
  const xml=`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const upload=(filename,mimeType,bytes)=>createAttachmentResource(f.context,{memoId:note.id,filename,mimeType,bytes,actor:f.actor});
  const image=await upload("pixel.png","image/png",Buffer.from(png,"base64"));
  const word=await upload("example.docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document",zipSync({"word/document.xml":strToU8(xml)}));
  const pdf=await upload("example.pdf","application/pdf",strToU8("%PDF fixture"));
  const session=emptyCompanionAgentSession(); const tools=f.tools(session);
  expect((await tools.read_memo_attachment.execute({memoId:note.id,resourceId:image.id})).contentBlock).toEqual({type:"image",mimeType:"image/png",data:png});
  let content="",offset=0;
  do { const page=await tools.read_memo_attachment.execute({memoId:note.id,resourceId:word.id,offset});content+=page.contentBlock.text;offset=page.nextOffset; } while(offset!==null);
  expect(content.trim()).toBe(text);
  expect(JSON.stringify(session)).not.toContain(png);
  await expect(tools.read_memo_attachment.execute({memoId:other.id,resourceId:word.id})).rejects.toMatchObject({code:"attachment_not_found"});
  await expect(tools.read_memo_attachment.execute({memoId:note.id,resourceId:pdf.id})).rejects.toMatchObject({code:"attachment_invalid_pdf"});
  await expect(f.tools().read_memo_attachment.execute({memoId:note.id,resourceId:pdf.id,mode:"original"})).rejects.toMatchObject({code:"attachment_format_unsupported"});
}));

test("built-in prose writes share MCP inbox rules, explicit destination and exact retry deduplication",()=>fixture(async f=>{
  const tools=f.tools(); const args={title:"assistant-write",contentMarkdown:"已确认的模型结论"};
  const first=await tools.create_memo.execute(args);
  const memo=first.memo;
  expect(memo.notebookId).toBe("inbox");
  expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id=?").get(memo.id).status).toBe("pending");
  const repeat=await tools.create_memo.execute(args); expect(repeat.memo.id).toBe(memo.id); expect(repeat.reused).toBe(true);
  const direct=await tools.create_memo.execute({...args,title:"specified",notebookId:"projects"});
  expect(direct.memo.notebookId).toBe("projects"); expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id=?").get(direct.memo.id)).toBeNull();
  expect(companionToolDefinitions(f.input).some(t=>t.name==="select_note_template")).toBe(true);
}));

test("advice requests enforce read-only tools even when a client asks for write access",()=>fixture(async f=>{
  const tools=f.tools(undefined,{message:"先给建议，不要修改笔记",allowWrites:true});
  expect(tools.get_memo).toBeDefined(); expect(tools.read_memo_attachment).toBeDefined();
  for(const name of ["create_memo","update_memo","move_memos","trash_memos","use_note_template"]) expect(tools[name]).toBeUndefined();
  expect(f.tools(undefined,{message:"请保存以下原文：\n不要修改笔记"}).create_memo).toBeDefined();
}));

test("standard notebook moves cancel old leases and requeue legacy notes moved into the inbox",()=>fixture(async f=>{
  const memo=await f.create();
  const move=async notebookId=>moveMemosRecord(f.db,f.scope.workspaceId,[memo.id],notebookId,f.actor,"owner",{
    before:[],after:()=>notebookClassificationChoice(f.env,f.auth,[memo.id],notebookId),
  });
  await move("inbox");
  expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id=?").get(memo.id).status).toBe("pending");
  f.sqlite.query("UPDATE inbox_classification_jobs SET available_at=0 WHERE memo_id=?").run(memo.id);
  await processInboxClassification(f.env,new AbortController().signal,async()=>{
    await move("projects"); return {notebookId:"projects",tags:[],reason:"late model result"};
  });
  expect((await getMemoDetail(f.db,f.scope.workspaceId,memo.id)).notebookId).toBe("projects");
  expect(f.sqlite.query("SELECT status,claim_token FROM inbox_classification_jobs WHERE memo_id=?").get(memo.id)).toEqual({status:"retained",claim_token:null});
  await move("inbox"); expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id=?").get(memo.id).status).toBe("pending");
}));

test("saving or appending a completed reply is atomic, idempotent, scoped and preserves source content",()=>fixture(async f=>{
  const turn=await beginCompanionTurn(f.db,f.scope,f.input,"mock");
  const answer="## 已验证的回答\n\n保留原文和引用 [来源](#memo=source)";
  await checkpointCompanionTurn(f.db,f.scope,turn,answer,[],"completed");
  const saved=await Promise.all([f.request(turn.id,{action:"create"}),f.request(turn.id,{action:"create"})]);
  for(const response of saved) expect(response.status).toBe(200);
  const results=await Promise.all(saved.map(r=>r.json())); expect(results[0].memo.id).toBe(results[1].memo.id);
  // A new note follows the shared AI conversation template and keeps the whole
  // answer verbatim under 结论.
  const savedBody=results[0].memo.contentMarkdown;
  expect(savedBody).toStartWith("## 结论\n\n");
  expect(savedBody).toContain(answer);
  expect(savedBody).toContain("## 关键步骤 / 依据");
  expect(savedBody).toContain("## 验证结果");
  expect(savedBody).toContain("## 来源 / 链接");
  expect(results[0].memo.tags).toContain("AI沉淀");
  expect(f.sqlite.query("SELECT COUNT(*) n FROM memos WHERE workspace_id=?").get(f.scope.workspaceId).n).toBe(1);
  const target=await f.create("原始文字\n\n![原图](/api/v1/resources/source/blob)");
  const payload={action:"append",memoId:target.id,expectedRevision:target.revision};
  const first=await f.request(turn.id,payload); expect(first.status).toBe(200);
  const retry=await f.request(turn.id,payload); expect(retry.status).toBe(200); expect((await retry.json()).reused).toBe(true);
  const updated=await getMemoDetail(f.db,f.scope.workspaceId,target.id);
  expect(updated.contentMarkdown).toBe(target.contentMarkdown+"\n\n---\n\n"+answer); expect(updated.revision).toBe(target.revision+1);
  // Appending to the open note keeps its explicit notebook instead of re-filing it.
  expect(updated.notebookId).toBe("projects");
  expect((await f.request(turn.id,{action:"create"},{"x-other":"1"})).status).toBe(409);
  const changed=await f.create(); await updateMemoRecord(f.db,f.scope.workspaceId,changed.id,{contentMarkdown:"changed"},f.actor,"owner");
  expect((await f.request(turn.id,{action:"append",memoId:changed.id,expectedRevision:changed.revision})).status).toBe(409);
  expect((await getMemoDetail(f.db,f.scope.workspaceId,changed.id)).contentMarkdown).toBe("changed");
}));


test("built-in edits cannot silently remove existing attachment references",()=>fixture(async f=>{
  const note=await f.create();
  const resource=await createAttachmentResource(f.context,{memoId:note.id,filename:"source.txt",mimeType:"text/plain",bytes:strToU8("original file"),actor:f.actor});
  const original=`正文\n\n[原件](${resource.url})`;
  await updateMemoRecord(f.db,f.scope.workspaceId,note.id,{contentMarkdown:original},f.actor,"owner");
  const tools=f.tools(); await tools.get_memo.execute({memoId:note.id});
  await expect(tools.update_memo.execute({memoId:note.id,contentMarkdown:"删除了原引用的新正文"})).rejects.toMatchObject({code:"attachment_reference_removed"});
  expect((await getMemoDetail(f.db,f.scope.workspaceId,note.id)).contentMarkdown).toBe(original);
}));

test("tool failures persist diagnostic receipts before returning an HTTP error",()=>fixture(async f=>{
  const turn=await beginCompanionTurn(f.db,f.scope,f.input,"mock");
  const response=await f.app.request(`/api/v1/companion/turns/${turn.id}/tools`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"get_memo",input:{memoId:"memo_missing"}})},f.env);
  expect(response.status).toBe(404);
  const row=f.sqlite.query("SELECT tools_json,agent_session_json FROM companion_turns WHERE id=?").get(turn.id);
  expect(JSON.parse(row.tools_json)).toMatchObject([{name:"get_memo",status:"error"}]);
  expect(JSON.parse(row.agent_session_json).calls).toBe(1);
}));
