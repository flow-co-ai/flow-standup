// GHL API v2 — aggregate metrics only. Never returns or logs PII.

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version:       GHL_VERSION,
    Accept:        'application/json',
  };
}

function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function nowISO() { return new Date().toISOString(); }
function round2(n) { return Math.round(n * 100) / 100; }

async function ghlGet(url, token) {
  const res = await fetch(url, { headers: ghlHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

// Follow meta.nextPageUrl until exhausted. Returns all items from listKey.
async function paginateCursor(firstUrl, token, listKey) {
  const items = [];
  let url = firstUrl;
  while (url) {
    const json = await ghlGet(url, token);
    const page = Array.isArray(json[listKey]) ? json[listKey] : [];
    items.push(...page);
    url = json.meta?.nextPageUrl || null;
  }
  return items;
}

// Fetch aggregate GHL metrics for locationId over the last 28 days.
// token must be the sub-account PIT for this specific location.
// Returns aggregate numbers only — no contact names, emails, or phone numbers.
export async function fetchGHL(locationId, token) {
  const startDate = daysAgoISO(27);
  const endDate   = nowISO();
  const enc       = encodeURIComponent;

  // 1. New contacts created in window
  const contactsUrl =
    `${GHL_BASE}/contacts/?locationId=${locationId}` +
    `&startDate=${enc(startDate)}&endDate=${enc(endDate)}&limit=100`;
  const contacts = await paginateCursor(contactsUrl, token, 'contacts');

  // 2. Opportunities — no date filter on endpoint, filter by createdAt in JS
  const oppsUrl = `${GHL_BASE}/opportunities/search?location_id=${locationId}&limit=100`;
  const allOpps = await paginateCursor(oppsUrl, token, 'opportunities');
  const start   = new Date(startDate);
  const end     = new Date(endDate);
  const opps    = allOpps.filter(o => {
    const created = o.createdAt ? new Date(o.createdAt) : null;
    return created && created >= start && created <= end;
  });
  const wonOpps  = opps.filter(o => (o.status || '').toLowerCase() === 'won');
  const sumValue = arr => arr.reduce((s, o) => s + (parseFloat(o.monetaryValue) || 0), 0);

  // 3. Appointments — list calendars, then count events per calendar
  const calsJson       = await ghlGet(`${GHL_BASE}/calendars/?locationId=${locationId}`, token);
  const calendars      = Array.isArray(calsJson.calendars) ? calsJson.calendars : [];
  let appointmentCount = 0;
  for (const cal of calendars) {
    const evtUrl  = `${GHL_BASE}/calendars/events?locationId=${locationId}` +
                    `&calendarId=${enc(cal.id)}&startTime=${enc(startDate)}&endTime=${enc(endDate)}`;
    const evtJson = await ghlGet(evtUrl, token);
    appointmentCount += Array.isArray(evtJson.events) ? evtJson.events.length : 0;
  }

  return {
    contacts:     contacts.length,
    opportunities: {
      created: { count: opps.length,    value: round2(sumValue(opps)) },
      won:     { count: wonOpps.length, value: round2(sumValue(wonOpps)) },
    },
    appointments: appointmentCount,
  };
}
