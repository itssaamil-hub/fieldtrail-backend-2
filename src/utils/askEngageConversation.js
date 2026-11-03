// Stateless, structured conversation context for Ask Engage's current chat panel.
// No CRM record, financial amount, message body or GPS data is stored or sent to Gemini.
const PERIODS = new Set(["all","today","yesterday","this_week","last_week","this_month",
  "last_month","this_quarter","last_quarter","this_year","last_year"]);
const PERIOD_PHRASES = Object.freeze({
  "today":"today","yesterday":"yesterday","this week":"this_week","last week":"last_week",
  "this month":"this_month","last month":"last_month","this quarter":"this_quarter",
  "last quarter":"last_quarter","this year":"this_year","last year":"last_year"
});
const GENERIC = /^(?:all|everyone|everybody|team|the team|employees?|all employees?|all staff|staff|overall|company|sales|our team|entire team|them|both|one|anyone|payments?|deals?|tasks?|visits?|quotations?|attendance)$/;

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/['’]s$/i,"").trim();
  if (!/^[a-z][a-z .'-]{1,65}$/i.test(name) || GENERIC.test(name.toLowerCase())) return null;
  return name;
}

// Untrusted client input is treated solely as a reporting preference, never an
// authorization decision. Employee IDs still resolve through existing DB checks.
function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.topic !== "employee_performance" || !PERIODS.has(value.period) ||
      !Array.isArray(value.employees) || value.employees.length < 1 ||
      value.employees.length > 2) return null;
  const employees = [];
  for (const raw of value.employees) {
    const name = normalizeName(raw);
    if (!name) return null;
    if (!employees.some(n => n.toLowerCase() === name.toLowerCase())) employees.push(name);
  }
  return employees.length ? {topic:"employee_performance",period:value.period,employees} : null;
}
function withEmployee(context, name, period) {
  const normalized = normalizeName(name);
  if (!normalized || !PERIODS.has(period)) return null;
  const prior = context?.topic === "employee_performance" ? context.employees : [];
  const employees = [...prior.filter(n => n.toLowerCase() !== normalized.toLowerCase()),normalized].slice(-2);
  return {topic:"employee_performance",period,employees};
}
function fromPlans(plans,previous) {
  if (!Array.isArray(plans) || plans.length === 0) return null;
  const performance = plans.filter(p => p?.intent === "employee_performance" && normalizeName(p.employee));
  if (!performance.length || performance.length !== plans.length) return null;
  let next = null;
  for (const plan of performance) {
    // Preserve a previous employee only when the user continues the same
    // performance thread. An unrelated report resets the context.
    next = withEmployee(next || (previous?.period === plan.period ? previous : null),
      plan.employee,plan.period);
  }
  return next;
}
function casual(question) {
  if (typeof question !== "string") return null;
  const q = question.toLowerCase().trim().replace(/[!?.\s]+$/g,"").replace(/\s+/g," ");
  if (/^(?:hi+|hey+|hello+|namaste|good morning|good afternoon|good evening)$/.test(q))
    return "Hi! What would you like to know about your CRM today?";
  if (/^(?:thanks|thank you|thank you so much|thx)$/.test(q))
    return "You're welcome! I can help with another CRM question whenever you're ready.";
  if (/^(?:bye+|goodbye|see you|see you later)$/.test(q))
    return "Goodbye! Ask me anytime you want to check your CRM.";
  if (/^(?:how are you|how are you doing|what's up|whats up)$/.test(q))
    return "I'm ready to help! Would you like to review deals, payments or employee performance?";
  if (/^(?:help|what can you do|what can i ask|how can you help)$/.test(q))
    return "I can check deals, payments, tasks and employee performance using live CRM reports. Try: How is Anand performing this month?";
  return null;
}
function separatePeriod(q, defaultPeriod) {
  const match = q.match(/\s+(today|yesterday|this week|last week|this month|last month|this quarter|last quarter|this year|last year)$/);
  return match ? {core:q.slice(0,match.index).trim(),period:PERIOD_PHRASES[match[1]]} :
    {core:q,period:defaultPeriod};
}
function classifyFollowup(question,context) {
  const normalized = normalizeContext(context);
  if (typeof question !== "string") return null;
  const greeting = casual(question);
  if (greeting) return {kind:"chat",answer:greeting,context:normalized};
  const q=question.toLowerCase().trim().replace(/[?!.,]+$/g,"").replace(/\s+/g," ");
  if (q.length>200) return null;
  const {core,period}=separatePeriod(q,normalized?.period || "all");
  const direct=core.match(/^compare\s+([a-z][a-z .'-]{1,65}?)\s+(?:and|with|vs\.?|versus)\s+([a-z][a-z .'-]{1,65})$/);
  if (direct) {
    const a=normalizeName(direct[1]),b=normalizeName(direct[2]);
    if (a && b && a.toLowerCase()!==b.toLowerCase()) {
      const next={topic:"employee_performance",period,employees:[a,b]};
      return {kind:"compare",context:next};
    }
  }
  if (!normalized) return null;
  if (/^(?:compare (?:them|both|these two|the two)|who (?:is|was) (?:better|performing better)|which (?:one|employee) (?:is|was) (?:better|performing better))$/.test(core)) {
    if (normalized.employees.length < 2) return {kind:"chat",
      answer:"I can compare employees. Which other employee would you like to compare?",
      context:normalized};
    return {kind:"compare",context:{...normalized,period}};
  }
  const other=core.match(/^(?:what|how) about\s+(.+)$/);
  if (other) {
    const name=normalizeName(other[1]);
    if (name) {
      const next=withEmployee(normalized,name,period);
      return {kind:"plans",plans:[{intent:"employee_performance",employee:name,period}],context:next};
    }
  }
  if (/^(?:what about|and|show|compare)(?: (?:the|for))? (?:this|last) (?:week|month|quarter|year)$/.test(core)) return null;
  if (/^(?:and |what about |how about )?(?:today|yesterday|this week|last week|this month|last month|this quarter|last quarter|this year|last year)$/.test(q)) {
    const updatedPeriod=PERIOD_PHRASES[q.replace(/^(?:and |what about |how about )/,"")];
    if (updatedPeriod) {
      const next={...normalized,period:updatedPeriod};
      if (next.employees.length===2) return {kind:"compare",context:next};
      return {kind:"plans",plans:[{intent:"employee_performance",
        employee:next.employees[0],period:updatedPeriod}],context:next};
    }
  }
  if (/^(?:why|why is that|why the difference)$/.test(core)) {
    return {kind:"chat",context:normalized,answer:"I can show verified performance differences, but these totals alone cannot establish why they happened. Ask me to compare recorded deals, tasks or visits."};
  }
  return null;
}
module.exports={normalizeContext,normalizeName,casual,classifyFollowup,fromPlans,withEmployee};
