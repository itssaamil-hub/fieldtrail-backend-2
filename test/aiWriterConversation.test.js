const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
require("express-async-errors");
const { PGlite } = require("@electric-sql/pglite");
const { signToken } = require("../src/utils/tokens");
const { _test: conversation } = require("../src/routes/aiWriterConversation.routes");

process.env.JWT_SECRET = "isolated-ai-conversation-test-secret";

test("conversational AI Writer validates Write My Own and requires explicit AI opt-in", () => {
  assert.equal(conversation.conversationOptions({type:"custom",instruction:"Make it personal",useGemini:true}).type,"custom");
  assert.equal(conversation.conversationOptions({instruction:"Draft a follow up",useGemini:true}).language,"english");
  assert.throws(()=>conversation.conversationOptions({type:"custom",instruction:"",useGemini:true}),/Tell AI/);
  assert.throws(()=>conversation.conversationOptions({type:"custom",instruction:"Hello",useGemini:false}),/Enable Gemini/);
  assert.throws(()=>conversation.conversationOptions({type:"custom",instruction:"x".repeat(751),useGemini:true}),/750/);
  assert.throws(()=>conversation.conversationOptions({type:"custom",instruction:"Hi",previousMessage:"x".repeat(1601),useGemini:true}),/too long/);
  assert.throws(()=>conversation.conversationOptions({type:"unknown",instruction:"Hi",useGemini:true}),/Unsupported/);
  assert.equal(conversation.parseConversationResponse({
    candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({message:"Hello, how are you?"})}]}}]
  }),"Hello, how are you?");
  assert.throws(()=>conversation.parseConversationResponse({candidates:[{finishReason:"STOP",content:{parts:[{text:"{\"message\":"}]}}]}),/incomplete/);
});

test("conversation route checks access and uses redacted context without persisting raw conversation", async () => {
  const pg = new PGlite();
  const admin=crypto.randomUUID(), owner=crypto.randomUUID(), another=crypto.randomUUID();
  const lead=crypto.randomUUID(), otherLead=crypto.randomUUID();
  await pg.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated;" +
    "CREATE TABLE users(id uuid PRIMARY KEY,role text,full_name text,is_active boolean,auth_version int);" +
    "CREATE TABLE leads(id uuid PRIMARY KEY,salesman_id uuid,business_name text,contact_name text,status text,next_follow_up_date date);"
  );
  await pg.exec(fs.readFileSync(path.join(__dirname,"../src/migrations/122_ai_writer_training.sql"),"utf8"));
  await pg.query(
    "INSERT INTO users VALUES ($1,'admin','Manager',true,0),($2,'salesman','Sales Rep',true,0),($3,'salesman','Another Rep',true,0)",
    [admin,owner,another]
  );
  await pg.query(
    "INSERT INTO leads VALUES ($1,$2,'Brew & Bun Café','Rahul','hot','2026-11-05'),($3,$4,'Other Restaurant','Sana','cold',NULL)",
    [lead,owner,otherLead,another]
  );
  const db = require("../src/db"), previousQuery=db.query, previousFetch=global.fetch;
  const previousKey=process.env.GEMINI_API_KEY, previousModel=process.env.GEMINI_MODEL;
  db.query=pg.query.bind(pg);
  process.env.GEMINI_API_KEY="test-only-placeholder";
  process.env.GEMINI_MODEL="gemini-test";
  const app=express();
  app.use(express.json());
  app.use("/ai-writer",require("../src/routes/aiWriterConversation.routes"));
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
  const server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  const realFetch=previousFetch;
  const sent=[];
  global.fetch=async(url,init)=>{
    if(!String(url).startsWith("https://generativelanguage.googleapis.com/"))return realFetch(url,init);
    sent.push(JSON.parse(init.body));
    return {ok:true,json:async()=>({candidates:[{
      finishReason:"STOP",content:{parts:[{text:JSON.stringify({
        message:"Hi [[OWNER]], I understand the concern. Would you like a quick walkthrough for [[BUSINESS]]?"
      })}]}
    }]})};
  };
  const call=async(user,body,id=lead)=>{
    const headers={"Content-Type":"application/json"};
    if(user)headers.Authorization="Bearer "+signToken({id:user,role:user===admin?"admin":"salesman"});
    const r=await fetch(base+"/ai-writer/leads/"+id+"/converse",{
      method:"POST",headers,body:JSON.stringify(body)
    });
    return {status:r.status,body:await r.json()};
  };
  try {
    const request={
      type:"custom",goal:"stay",language:"english",tone:"friendly",useGemini:true,
      notes:"Rahul of Brew & Bun Café is worried about the price.",
      instruction:"Write a supportive reply to Rahul. No demo pitch. Email him at hello@example.com.",
      previousMessage:"Hi Rahul, from Sales Rep at Brew & Bun Café, contact +91 9899121234."
    };
    assert.equal((await call(null,request)).status,401);
    const denied=await call(another,request);
    assert.equal(denied.status,404,JSON.stringify(denied.body));
    assert.equal((await call(owner,{...request,useGemini:false})).status,400);
    assert.equal(sent.length,0);
    const result=await call(owner,request);
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.source,"gemini");
    assert.match(result.body.message,/Rahul/);
    assert.match(result.body.message,/Brew & Bun Café/);
    assert.equal(sent.length,1);
    const prompt=sent[0].contents[0].parts[0].text;
    assert.match(prompt,/Message type: custom/);
    assert.match(prompt,/For Write My Own/);
    assert.match(prompt,/Current CRM stage .*hot/);
    assert.match(prompt,/2026-11-05/);
    assert.match(prompt,/one-to-one WhatsApp message/);
    assert.doesNotMatch(prompt,/Brew & Bun Café|Rahul|9899121234|hello@example.com|Sales Rep/);
    assert.match(prompt,/\[\[OWNER\]\]/);
    assert.match(prompt,/\[\[BUSINESS\]\]/);
    assert.equal(sent[0].generationConfig.responseSchema.required[0],"message");
    assert.equal((await call(admin,request,otherLead)).status,200);
    delete process.env.GEMINI_API_KEY;
    const missing=await call(owner,request);
    assert.equal(missing.status,503);
    assert.match(missing.body.error,/not configured/);
    assert.equal(sent.length,2);
  } finally {
    global.fetch=previousFetch;db.query=previousQuery;
    if(previousKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previousKey;
    if(previousModel===undefined)delete process.env.GEMINI_MODEL;else process.env.GEMINI_MODEL=previousModel;
    await new Promise(resolve=>server.close(resolve));
    await pg.close();
  }
});
