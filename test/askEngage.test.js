const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ask = require("../src/routes/askEngage.routes")._test;

test("Ask Engage rejects malformed user questions and prevents arbitrary intent",()=>{
  assert.deepEqual(ask.validateQuestion({question:"  Show pending payments  ",previousQuestion:"hi"}),{
    question:"Show pending payments",previousQuestion:"hi"
  });
  for (const question of ["abc","", "x".repeat(281),null]) {
    assert.throws(()=>ask.validateQuestion({question}),/question/i);
  }
  assert.throws(()=>ask.validatePlan({intent:"execute_sql",employee:"",period:"all"}),/rephrase/);
  assert.throws(()=>ask.validatePlan({intent:"created_deals",employee:"",period:"2030"}),/rephrase/);
  assert.deepEqual(ask.validatePlan({intent:"created_deals",employee:" Anand ",period:"this_month"}),{
    intent:"created_deals",employee:"Anand",period:"this_month"
  });
});

test("Gemini receives only questions and a strict enum schema, no CRM records",async()=>{
  const previous=process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY="fake_testing_key";
  const record=[];
  try {
    const plan=await ask.classifyQuestion({question:"How many deals did Anand add this month?",previousQuestion:""},async(url,opts)=>{
      record.push({url,opts});
      return {ok:true,json:async()=>({candidates:[{finishReason:"STOP",
        content:{parts:[{text:JSON.stringify({intent:"created_deals",employee:"Anand",period:"this_month"})}]}
      }]})};
    });
    assert.equal(plan.intent,"created_deals");
    assert.equal(record.length,1);
    const json=JSON.parse(record[0].opts.body);
    const prompt=json.contents[0].parts[0].text;
    assert.match(prompt,/How many deals did Anand add/);
    assert.doesNotMatch(prompt,/lead_payments|SELECT .* FROM leads/i);
    assert.equal(json.generationConfig.responseMimeType,"application/json");
    assert.ok(json.generationConfig.responseSchema.properties.intent.enum.includes("unsupported"));
    assert.equal(record[0].opts.headers["x-goog-api-key"],"fake_testing_key");
    assert.doesNotMatch(json.contents[0].parts[0].text,/fake_testing_key/);
  } finally {
    if(previous===undefined)delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY=previous;
  }
});

test("Deal-created count uses actual creator activity, not current ownership",async()=>{
  const seen=[];
  const query=async(sql,params)=>{
    seen.push({sql,params});
    if(sql.includes("FROM users"))return {rows:[{id:"employee-uuid",full_name:"Anand Kumar"}]};
    if(sql.includes("count(DISTINCT"))return {rows:[{count:12}]};
    throw Error("Unexpected SQL");
  };
  const result=await ask.executePlan({intent:"created_deals",employee:"Anand",period:"this_month"},query);
  assert.equal(result.count,12);
  assert.match(result.answer,/Anand Kumar: 12/);
  assert.match(seen[1].sql,/activity_logs al/);
  assert.match(seen[1].sql,/al.actor_id/);
  assert.match(seen[1].sql,/Asia\/Kolkata/);
  assert.deepEqual(seen[1].params,["employee-uuid"]);
  assert.doesNotMatch(seen[1].sql,/INSERT INTO|UPDATE |DELETE FROM/);
});

test("Payment answers respect canonical account source, statuses, currency and max 10",async()=>{
  const seen=[];
  const query=async(sql,params)=>{
    seen.push({sql,params});
    if(sql.includes("GROUP BY currency"))return {rows:[
      {currency:"INR",account_count:3,total:"30000",paid:"12000",balance:"18000"},
      {currency:"AED",account_count:2,total:"900",paid:"200",balance:"700"}
    ]};
    return {rows:[{
      key:"lead:known",business_name:"Restaurant Example",currency:"INR",
      paid:"0",balance:"10000",due_date:"2026-11-05",owner_name:"Anand",status:"Pending"
    }]};
  };
  const out=await ask.executePlan({intent:"outstanding_payments",employee:"",period:"all"},query);
  assert.equal(out.count,5);
  assert.equal(out.totals.length,2);
  assert.equal(out.items.length,1);
  assert.equal(out.totals[0].balance,18000);
  assert.equal(out.items[0].name,"Restaurant Example");
  assert.equal(out.items[0].dueDate,"2026-11-05");
  assert.match(seen[0].sql,/collection_accounts/);
  assert.match(seen[0].sql,/lead_payments/);
  assert.match(seen[0].sql,/greatest\(c\.total-coalesce\(p\.paid,0\),0\)/);
  assert.match(seen[1].sql,/LIMIT 10/);
  assert.match(seen[1].sql,/balance > 0/);
  for (const q of seen) {
    assert.deepEqual(q.params,[null]);
    assert.doesNotMatch(q.sql,/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  }
});

test("Payment due period filters due date, not payment transaction history",()=>{
  assert.equal(ask.dateFilter("all","due_date",false),"TRUE");
  assert.match(ask.dateFilter("this_month","due_date",false),/due_date::timestamp/);
  assert.match(ask.dateFilter("last_month","due_date",false),/interval '1 month'/);
  assert.match(ask.paymentWhere({intent:"overdue_payments",period:"all"}),/due_date </);
  assert.match(ask.paymentWhere({intent:"unpaid_payments",period:"all"}),/paid = 0/);
  assert.match(ask.paymentWhere({intent:"partial_payments",period:"all"}),/paid > 0/);
  assert.throws(()=>ask.paymentWhere({intent:"arbitrary",period:"all"}),/Unsupported/);
});

test("Employee disambiguation prevents silently selecting the wrong employee",async()=>{
  await assert.rejects(
    ask.findEmployee("Anand",async()=>({rows:[{id:"1",full_name:"Anand Kumar"},{id:"2",full_name:"Anand Singh"}]})),
    /More than one employee/
  );
  await assert.rejects(ask.findEmployee("Fake",async()=>({rows:[]})),/No employee matches/);
});

test("Admin-only Ask Engage route is read-only and isolated from attendance or payment writers",()=>{
  const src=fs.readFileSync(require.resolve("../src/routes/askEngage.routes"),"utf8");
  const app=fs.readFileSync(require.resolve("../src/app"),"utf8");
  assert.match(src,/router\.use\(requireAuth, requireRole\("admin"\)\)/);
  assert.match(src,/router\.post\("\/ask"/);
  assert.match(app,/app\.use\("\/admin\/ask-engage"/);
  assert.doesNotMatch(src,/db\.query\(\s*["']\s*(?:INSERT|UPDATE|DELETE)/i);
  assert.doesNotMatch(src,/exec\(|eval\(|new Function\(/);
  assert.match(src,/Gemini selects a constrained intent/);
});
