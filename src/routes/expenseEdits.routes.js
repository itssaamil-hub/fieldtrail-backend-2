const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT=1000000000;

function validExpenseDate(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))) return false;
  const d=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===value;
}
function validateExpenseBody(body={}){
  const {category,amount,salesmanId,note,spentOn}=body;
  const numAmount=Number(amount);
  if(!category || typeof category!=="string" || !category.trim() || category.trim().length>120) return "Pick a valid category.";
  if(!Number.isFinite(numAmount) || numAmount<=0 || numAmount>MAX_AMOUNT) return "Enter a valid amount.";
  if(salesmanId && !UUID.test(String(salesmanId))) return "Selected employee is not valid.";
  if(note!=null && (typeof note!=="string" || note.length>2000)) return "Note must be at most 2000 characters.";
  if(spentOn && !validExpenseDate(String(spentOn))) return "Enter a valid expense date.";
  return null;
}
async function activeSalesman(client,salesmanId){
  if(!salesmanId) return true;
  const {rows}=await client.query("SELECT id FROM users WHERE id=$1 AND role='salesman' AND is_active=true FOR SHARE",[salesmanId]);
  return rows.length>0;
}
async function rollback(client,res,status,error){await client.query('ROLLBACK');res.status(status).json({error});return null;}
async function salesmanName(client,id){
  if(!id) return null;
  const {rows}=await client.query('SELECT full_name FROM users WHERE id=$1',[id]);
  return rows[0]?.full_name||null;
}
function shape(expense,name){
  return {id:expense.id,category:expense.category,amount:Number(expense.amount),note:expense.note,spentOn:expense.spent_on,salesmanId:expense.salesman_id,salesmanName:name||null};
}

// Create is handled here before the legacy admin router so create/edit/delete
// all share the same validation, active-employee checks and audit trail.
router.post("/", async (req,res)=>{
  const validation=validateExpenseBody(req.body||{});
  if(validation) return res.status(400).json({error:validation});
  const {category,amount,salesmanId,note,spentOn}=req.body||{};
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN');
    if(!(await activeSalesman(client,salesmanId))) return await rollback(client,res,400,"Selected employee is not active.");
    const {rows}=await client.query(
      `INSERT INTO expenses(category,amount,salesman_id,note,spent_on,recorded_by)
       VALUES($1,$2,$3,$4,COALESCE($5::date,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),$6)
       RETURNING id,category,amount,note,spent_on,salesman_id`,
      [category.trim(),Number(amount),salesmanId||null,note?note.trim():null,spentOn||null,req.user.id]
    );
    const expense=rows[0];
    await client.query(
      `INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
       VALUES($1,'expense.created','expense',$2,$3::jsonb)`,
      [req.user.id,expense.id,JSON.stringify({category:expense.category,amount:Number(expense.amount),spentOn:expense.spent_on,salesmanId:expense.salesman_id})]
    );
    const name=await salesmanName(client,expense.salesman_id);
    await client.query('COMMIT');
    res.status(201).json({expense:shape(expense,name)});
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});

router.patch("/:id", async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid expense." });
  const validation=validateExpenseBody(req.body||{});
  if(validation) return res.status(400).json({error:validation});
  const { category, amount, salesmanId, note, spentOn } = req.body || {};
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    if(!(await activeSalesman(client,salesmanId))) return await rollback(client,res,400,"Selected employee is not active.");
    const { rows } = await client.query(
      `UPDATE expenses SET category=$2,amount=$3,salesman_id=$4,note=$5,spent_on=COALESCE($6::date,spent_on)
       WHERE id=$1 RETURNING id,category,amount,note,spent_on,salesman_id`,
      [req.params.id,category.trim(),Number(amount),salesmanId||null,note?note.trim():null,spentOn||null]
    );
    if (!rows[0]) return await rollback(client,res,404,"Expense not found");
    const expense=rows[0];
    await client.query(
      `INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
       VALUES($1,'expense.updated','expense',$2,$3::jsonb)`,
      [req.user.id,expense.id,JSON.stringify({category:expense.category,amount:Number(expense.amount),spentOn:expense.spent_on,salesmanId:expense.salesman_id})]
    );
    const name=await salesmanName(client,expense.salesman_id);
    await client.query('COMMIT');
    res.json({expense:shape(expense,name)});
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
});

router.delete("/:id", async (req,res)=>{
  if(!UUID.test(req.params.id)) return res.status(400).json({error:"Invalid expense."});
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query(
      `SELECT id,category,amount,note,spent_on,salesman_id FROM expenses WHERE id=$1 FOR UPDATE`,
      [req.params.id]
    );
    if(!rows[0]) return await rollback(client,res,404,"Expense not found");
    const expense=rows[0];
    await client.query(
      `INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
       VALUES($1,'expense.deleted','expense',$2,$3::jsonb)`,
      [req.user.id,expense.id,JSON.stringify({category:expense.category,amount:Number(expense.amount),spentOn:expense.spent_on,salesmanId:expense.salesman_id,note:expense.note})]
    );
    await client.query('DELETE FROM expenses WHERE id=$1',[req.params.id]);
    await client.query('COMMIT');
    res.json({ok:true});
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});

module.exports = router;
