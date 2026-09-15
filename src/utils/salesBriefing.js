// Deterministic, free briefing: no external AI service or API key.
function localDate(now = new Date(), timeZone = process.env.BRIEFING_TIMEZONE || 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function buildBriefing(leads, date, fullName = "") {
  const active = leads.filter(l => !['won', 'lost'].includes(l.status));
  const counts = {
    followUpsToday: active.filter(l => l.next_follow_up_date === date).length,
    overdueFollowUps: active.filter(l => l.next_follow_up_date && l.next_follow_up_date < date).length,
    demoStageLeads: active.filter(l => ['demo', 'demo_scheduled'].includes(l.status)).length,
    activeLeads: active.length,
  };
  const ranked = active.map(l => {
    const reasons = [];
    let score = 0;
    if (l.next_follow_up_date && l.next_follow_up_date < date) {
      score += 100; reasons.push('Overdue follow-up');
    } else if (l.next_follow_up_date === date) {
      score += 80; reasons.push('Follow-up today');
    }
    if (l.status === 'hot') { score += 40; reasons.push('Hot lead'); }
    if (l.status === 'negotiation') { score += 30; reasons.push('In negotiation'); }
    if (['demo', 'demo_scheduled'].includes(l.status)) { score += 20; reasons.push('In demo stage'); }
    // Respect a future follow-up appointment; no need to bring it forward.
    if (l.next_follow_up_date > date) score = 0;
    return { ...l, score, reasons };
  }).filter(l => l.score > 0).sort((a, b) =>
    b.score - a.score || (a.next_follow_up_date || '9999').localeCompare(b.next_follow_up_date || '9999') || String(a.id).localeCompare(String(b.id))
  ).slice(0, 5);
  const briefing = { date, mode: 'rules', counts, priorityLeads: ranked };
  return { ...briefing, ...writeNarrative(briefing, fullName) };
}

function writeNarrative({ counts: c, priorityLeads }, fullName = '') {
  const name = String(fullName || '').trim().split(/\s+/)[0];
  const greeting = name ? `Hello, ${name}!` : 'Hello!';
  const quantity = (n, singular, plural = singular + 's') => `${n} ${n === 1 ? singular : plural}`;
  const paragraphs = [];
  if (!c.activeLeads) {
    paragraphs.push('You have no active leads in your pipeline yet. Add new prospects to get your next follow-ups moving.');
  } else if (!c.followUpsToday && !c.overdueFollowUps) {
    paragraphs.push('You have no follow-ups due today and nothing overdue.');
  } else {
    const today = c.followUpsToday ? `${quantity(c.followUpsToday, 'follow-up')} today` : 'no follow-ups due today';
    const overdue = c.overdueFollowUps ? `${quantity(c.overdueFollowUps, 'overdue contact')} to catch up with` : 'no overdue contacts';
    paragraphs.push(`You have ${today} and ${overdue}.`);
  }
  const describe = lead => {
    const stage = { hot: 'a hot lead', negotiation: 'in negotiation', demo: 'in the demo stage', demo_scheduled: 'in the demo stage' }[lead.status];
    const due = lead.reasons.includes('Overdue follow-up') ? 'its follow-up is overdue' : lead.reasons.includes('Follow-up today') ? 'its follow-up is due today' : '';
    return [stage ? `it’s ${stage}` : '', due].filter(Boolean).join(' and ');
  };
  if (priorityLeads.length) {
    paragraphs.push(priorityLeads.slice(0, 2).map((lead, index) =>
      `${index ? 'Next, contact' : 'Start with'} ${lead.business_name}—${describe(lead)}.`
    ).join(' '));
  }
  if (c.demoStageLeads) {
    paragraphs.push(`You also have ${quantity(c.demoStageLeads, 'lead')} in the demo stage. Review their next steps and any scheduled follow-up dates.`);
  }
  const focus = c.overdueFollowUps ? 'Clear overdue follow-ups first, then work through today’s contacts.'
    : c.followUpsToday ? 'Work through today’s follow-ups, starting with your priority contacts.'
    : priorityLeads.length ? 'Check in with your priority leads and agree on their next steps.'
    : c.activeLeads ? 'Review your pipeline and plan your next follow-ups.' : 'Add new prospects and schedule your first follow-ups.';
  const names = priorityLeads.slice(0, 2).map(l => l.business_name.slice(0, 60));
  const notificationBody = `${name ? name + ', ' : ''}${quantity(c.followUpsToday, 'follow-up')} today, ${c.overdueFollowUps} overdue.` +
    (names.length ? ` Start with ${names.join(', then ')}.` : ` ${focus}`);
  return { greeting, paragraphs, focus, recommendation: focus, summary: paragraphs.join(' '), notificationBody };
}

async function getBriefing(userId, date = localDate()) {
  const db = require('../db');
  const { rows } = await db.query(
    `SELECT id, business_name, contact_name, phone, status,
            to_char(next_follow_up_date, 'YYYY-MM-DD') AS next_follow_up_date
     FROM leads WHERE salesman_id = $1 AND status NOT IN ('won', 'lost')`, [userId]);
  const { rows: users } = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
  return { ...buildBriefing(rows, date, users[0]?.full_name), timeZone: process.env.BRIEFING_TIMEZONE || 'Asia/Kolkata' };
}

async function runSalesBriefings() {
  const db = require('../db');
  const { notifyUsers } = require('./pushNotifications');
  const date = localDate();
  const result = { date, sentUsers: 0, sentDevices: 0, skippedUsers: 0, failedUsers: 0 };
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return { ...result, reason: 'Push notifications are not configured' };
  }
  const { rows: users } = await db.query(
    `SELECT u.id FROM users u
     LEFT JOIN notification_preferences p ON p.user_id = u.id
     WHERE u.role = 'salesman' AND u.is_active = true
       AND COALESCE(p.sales_briefing, true)
       AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)`);
  for (const user of users) {
    // Session lock prevents overlapping scheduler requests for the same user.
    const client = await db.pool.connect();
    let locked = false;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`sales-briefing:${user.id}`]);
      locked = lock.rows[0].locked;
      if (!locked) { result.skippedUsers++; continue; }
      const prior = await client.query('SELECT 1 FROM sales_briefing_deliveries WHERE user_id = $1 AND day = $2', [user.id, date]);
      if (prior.rowCount) { result.skippedUsers++; continue; }
      const briefing = await getBriefing(user.id, date);
      const delivery = await notifyUsers([user.id], 'sales_briefing', {
        title: 'Your daily sales briefing',
        body: briefing.notificationBody,
        url: '/#sales-briefing', tag: `sales-briefing-${date}`,
      });
      if (delivery.sent > 0) {
        await client.query('INSERT INTO sales_briefing_deliveries (user_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, date]);
        result.sentUsers++; result.sentDevices += delivery.sent;
      } else if (delivery.failed > 0) result.failedUsers++;
      else result.skippedUsers++;
    } catch (err) {
      result.failedUsers++;
      console.error('Sales briefing failed for user', user.id, err.message);
    } finally {
      // Destroy the connection if unlock fails so a pooled session cannot retain the lock.
      let unlockError;
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`sales-briefing:${user.id}`]); }
        catch (err) { unlockError = err; }
      }
      client.release(unlockError);
    }
  }
  return result;
}
module.exports = { localDate, buildBriefing, getBriefing, runSalesBriefings };
