const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
require("express-async-errors");
const { PGlite } = require("@electric-sql/pglite");
const { signToken } = require("../src/utils/tokens");
const training = require("../src/utils/aiWriterTraining");
process.env.JWT_SECRET = "isolated-ai-training-test-secret";

test("training validates limits and redacts named customer/contact, phone, email and URL", () => {
  assert.throws(() => training.validateSettings({company_knowledge:"x".repeat(5001),writing_instructions:""}));
  assert.throws(() => training.validateExample({message:"too short"}));
  const sample = training.anonymizeExample(
    "Hi Rahul, thanks for meeting Brew & Bun Café. Call +91 9899121234 or write a@sample.com at https://example.com. Regards, Anand Singh.",
    {business_name:"Brew & Bun Café",contact_name:"Rahul"}, "Anand Singh"
  );
  assert.match(sample, /\[\[OWNER\]\]/);
  assert.match(sample, /\[\[BUSINESS\]\]/);
  assert.match(sample, /\[\[SENDER\]\]/);
  assert.doesNotMatch(sample, /Rahul|Brew & Bun|9899121234|a@sample|example.com|Anand Singh/);
});

test("admin controls and approved-only Gemini training through isolated PostgreSQL", async () => {
  const pg = new PGlite();
  const admin = crypto.randomUUID(), staff = crypto.randomUUID(), other = crypto.randomUUID();
  const lead = crypto.randomUUID(), otherLead = crypto.randomUUID();
  await pg.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE users(id uuid PRIMARY KEY,role text,full_name text,is_active boolean,auth_version int);
    CREATE TABLE leads(id uuid PRIMARY KEY,salesman_id uuid,business_name text,contact_name text);`);
  await pg.exec(fs.readFileSync(path.join(__dirname,"../src/migrations/122_ai_writer_training.sql"),"utf8"));
  await pg.query("INSERT INTO users VALUES ($1,'admin','Admin',true,0),($2,'salesman','Anand Singh',true,0),($3,'salesman','Other',true,0)",[admin,staff,other]);
  await pg.query("INSERT INTO leads VALUES ($1,$2,'Brew & Bun Café','Rahul'),($3,$4,'Another Café','Someone')",[lead,staff,otherLead,other]);
  const db = require("../src/db"), oldQuery=db.query,oldFetch=global.fetch;
  const oldKey=process.env.GEMINI_API_KEY,oldModel=process.env.GEMINI_MODEL;
  db.query = pg.query.bind(pg);
  process.env.GEMINI_API_KEY = "mock-key-not-valid";
  process.env.GEMINI_MODEL = "gemini-test";
  const app=express();
  app.use(express.json());
  app.use("/ai-writer/training",require("../src/routes/aiWriterTraining.routes"));
  app.use("/ai-writer",require("../src/routes/leadAiWriter.routes"));
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
  const server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  const call=async(method,url,body,who=admin)=>{
    const headers={"Content-Type":"application/json"};
    if(who)headers.Authorization="Bearer "+signToken({id:who,role:who===admin?"admin":"salesman",full_name:who===staff?"Anand Singh":"Admin"});
    const r=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  // Proxy the app's HTTP request with Node's real fetch; mock only the
  // outgoing Google API request when the URL targets Google's hostname.
  const realFetch=oldFetch;
  let sentPrompts=[];
  global.fetch=async(input,options)=>{
    if(!String(input).startsWith("https://generativelanguage.googleapis.com/"))return realFetch(input,options);
    sentPrompts.push(JSON.parse(options.body).contents[0].parts[0].text);
    return {ok:true,json:async()=>({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({
      short:"Hello [[OWNER]], would a quick demo suit [[BUSINESS]]? Regards [[SENDER]] at Swirl.cx.",
      natural:"Hi [[OWNER]], thanks for talking about [[BUSINESS]]. Would a quick demo work? Regards [[SENDER]] at Swirl.cx.",
      professional:"Dear [[OWNER]], thank you for your time regarding [[BUSINESS]]. May we arrange a brief demo? Regards [[SENDER]] at Swirl.cx."
    })}]}}]})};
  };
  try {
    assert.equal((await call("GET","/ai-writer/training/config",undefined,staff)).status,403);
    assert.equal((await call("GET","/ai-writer/training/config",undefined,null)).status,401);
    let r=await call("PUT","/ai-writer/training/config",{
      company_knowledge:"Verified: Swirl.cx offers restaurant POS.",
      writing_instructions:"Write respectful, short WhatsApp messages."
    });
    assert.equal(r.status,200,JSON.stringify(r.body));
    const example={leadId:lead,message:"Hi Rahul, thank you for meeting Brew & Bun Café. Let's discuss a quick demo. Regards, Anand Singh. +91 9899121234",
      language:"hinglish",type:"after",goal:"demo",tone:"respectful"};
    assert.equal((await call("POST","/ai-writer/training/examples",{...example,leadId:otherLead},staff)).status,404);
    r=await call("POST","/ai-writer/training/examples",example,staff);
    assert.equal(r.status,201,JSON.stringify(r.body));
    assert.equal(r.body.example.status,"pending");
    const id=r.body.example.id;
    assert.doesNotMatch(r.body.example.message,/Rahul|Brew & Bun|Anand Singh|9899121234/);
    assert.equal((await call("GET","/ai-writer/training/examples",undefined,staff)).status,403);
    let ls=await call("GET","/ai-writer/training/examples?status=pending");
    assert.equal(ls.body.examples.length,1);
    assert.equal((await call("PATCH","/ai-writer/training/examples/"+id,{status:"approved"},staff)).status,403);
    // An unapproved example must never be inserted into the Gemini prompt.
    let draft=await call("POST","/ai-writer/leads/"+lead+"/draft",{useGemini:true,notes:"Interested in inventory."},staff);
    assert.equal(draft.status,200,JSON.stringify(draft.body));
    assert.equal(draft.body.source,"gemini");
    assert.match(sentPrompts[0],/Verified: Swirl.cx offers restaurant POS/);
    assert.doesNotMatch(sentPrompts[0],/thank you for meeting/);
    assert.doesNotMatch(sentPrompts[0],/Rahul|Brew & Bun Café/);
    assert.equal((await call("PATCH","/ai-writer/training/examples/"+id,{status:"approved"})).status,200);
    draft=await call("POST","/ai-writer/leads/"+lead+"/draft",{useGemini:true,notes:"Interested in inventory."},staff);
    assert.equal(draft.body.source,"gemini");
    assert.match(sentPrompts[1],/thank you for meeting/);
    assert.doesNotMatch(sentPrompts[1],/Rahul|Brew & Bun Café/);
    assert.match(draft.body.drafts.natural,/Rahul/);
    const preview=await call("POST","/ai-writer/training/test",{notes:"Interested in a demo",useGemini:true,type:"after",goal:"demo",language:"hinglish",tone:"respectful"});
    assert.equal(preview.status,200,JSON.stringify(preview.body));
    assert.equal(preview.body.source,"gemini");
    assert.equal((await call("POST","/ai-writer/training/test",{notes:"Demo"},staff)).status,403);
    assert.equal((await call("DELETE","/ai-writer/training/examples/"+id,undefined,staff)).status,403);
    assert.equal((await call("DELETE","/ai-writer/training/examples/"+id)).status,200);
    ls=await call("GET","/ai-writer/training/examples?status=all");
    assert.equal(ls.body.examples.length,0);
    // No direct Data API reads of the private training tables.
    await pg.exec("SET ROLE anon");
    await assert.rejects(pg.query("SELECT * FROM ai_writer_training_examples"),/permission denied/i);
    await pg.exec("RESET ROLE");
  } finally {
    global.fetch=oldFetch;
    db.query=oldQuery;
    if(oldKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey;
    if(oldModel===undefined)delete process.env.GEMINI_MODEL;else process.env.GEMINI_MODEL=oldModel;
    await new Promise(resolve=>server.close(resolve));
    await pg.close();
  }
});
