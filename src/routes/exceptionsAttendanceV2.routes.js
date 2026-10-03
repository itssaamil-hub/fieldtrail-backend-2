const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildDetections, loadDetectionSources } = require('../utils/exceptionDetection');
const { loadAttendanceReport, attendanceExceptionDetections } = require('../utils/attendanceReportV2');
const exceptionRoutes = require('./exceptions.routes');

const router=express.Router();
router.use(requireAuth,requireRole('admin'));

// Mounted before the legacy Exception Centre router. It preserves every existing
// detector and adds attendance anomalies from the same transaction/snapshot.
router.post('/refresh', async (req,res) => {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const q=client.query.bind(client);
    const source=await loadDetectionSources(q);
    const base=buildDetections(source);
    const rangeResult=await q("SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-6)::text AS from_day,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS to_day");
    const {from_day:from,to_day:to}=rangeResult.rows[0];
    const attendanceReport=await loadAttendanceReport(q,{from,to});
    const attendance=attendanceExceptionDetections(attendanceReport).map(item=>({
      ...item,
      type:'employee',
      fingerprint:`attendance:${item.metadata?.anomalyType || 'issue'}:${item.entityId}`,
      metadata:{...(item.metadata||{}),source:'attendance_v2'},
    }));
    const synced=await exceptionRoutes._test.syncCases(client,[...base,...attendance]);
    await client.query('COMMIT');
    res.json({
      ok:true,synced,
      sourceCounts:{leads:source.leads.length,tasks:source.tasks.length,accounts:source.collections.length,attendance:attendance.length},
    });
  } catch(err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
});

module.exports=router;
