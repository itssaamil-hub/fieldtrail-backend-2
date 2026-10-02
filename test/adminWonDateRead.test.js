const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("admin lead reads expose canonical Won milestone date", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/routes/adminLeadPagination.routes.js"), "utf8");
  assert.match(source, /LEFT JOIN lead_stage_milestones won ON won\.lead_id = l\.id AND won\.stage = 'won'/);
  assert.match(source, /won\.occurred_at AS won_date/);
  assert.doesNotMatch(source, /created_at AS won_date/);
});
