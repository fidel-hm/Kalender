/**
 * Freundeskalender - API + ICS-Feed auf Cloudflare Workers mit D1.
 *
 * Auth: jeder Nutzer hat ein unbegrenzt gueltiges Token (aus dem Einladungslink),
 * das als "Authorization: Bearer <token>" mitgeschickt wird. Kein Session-Handling,
 * kein Ablauf → man muss sich nie wieder einloggen.
 */

const STATUSES = ['yes', 'maybe', 'no'];
/** Anzeigefarben der Personen; neu angelegte Personen bekommen reihum die naechste. */
const PALETTE = [
  '#1971c2', '#2f9e44', '#e8590c', '#6741d9', '#0c8599', '#c2255c',
  '#f08c00', '#099268', '#9c36b5', '#e03131', '#846358', '#495057',
];
const COLOR_RE = /^#[0-9a-f]{6}$/;
const ZONE = 'Europe/Berlin';

// ---------------------------------------------------------------- Hilfsmittel

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (status, message) => {
  throw new HttpError(status, message);
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

/** Zufälliges, URL-sicheres Token (24 Byte Entropie). */
function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    bad(400, 'Ungültiger JSON-Body');
  }
}

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const ZONE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

const zonenTeile = (date) => {
  const teile = {};
  for (const { type, value } of ZONE_PARTS.formatToParts(date)) teile[type] = value;
  return teile;
};

/** Abstand der Zone zu UTC in Millisekunden, zum Zeitpunkt `date`. */
function zonenVersatz(date) {
  const t = zonenTeile(date);
  const alsUtc = Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour % 24, +t.minute, +t.second);
  return alsUtc - date.getTime();
}

/**
 * 23:59 des Kalendertags (Berliner Zeit), an dem der Termin beginnt.
 * Termine ohne Endzeit laufen bis dahin, statt eine Dauer zu erfinden.
 */
function endeDesTages(startIso) {
  const t = zonenTeile(new Date(startIso));
  const naiv = Date.UTC(+t.year, +t.month - 1, +t.day, 23, 59, 0);
  // Zwei Durchlaeufe, damit die Zeitumstellung korrekt getroffen wird.
  let wert = naiv;
  for (let i = 0; i < 2; i++) wert = naiv - zonenVersatz(new Date(wert));
  return new Date(wert).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ------------------------------------------------------------------- Routing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // ICS-Feed: Token steckt im Pfad, weil Kalender-Apps keine Header senden können.
    const icsMatch = path.match(/^\/ics\/([A-Za-z0-9_-]{16,128})\.ics$/);
    if (icsMatch) return icsFeed(icsMatch[1], url, env);

    if (path === '/') return new Response('Freundeskalender-API. Siehe /api/health', { status: 200 });

    try {
      if (!path.startsWith('/api/')) bad(404, 'Unbekannter Pfad');
      return await handleApi(request, url, path, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, env);
      console.error(err);
      return json({ error: 'Interner Fehler' }, 500, env);
    }
  },
};

async function handleApi(request, url, path, env) {
  if (path === '/api/health') return json({ ok: true }, 200, env);

  const me = await authenticate(request, env);
  const method = request.method;

  if (path === '/api/state' && method === 'GET') return getState(me, url, env);
  if (path === '/api/me' && method === 'PATCH') return updateMe(request, me, env);

  if (path === '/api/events' && method === 'POST') return createEvent(request, me, env);

  const eventMatch = path.match(/^\/api\/events\/(\d+)$/);
  if (eventMatch) {
    const id = Number(eventMatch[1]);
    if (method === 'PATCH') return updateEvent(request, id, me, env);
    if (method === 'DELETE') return deleteEvent(id, me, env);
    bad(405, 'Methode nicht erlaubt');
  }

  const rsvpMatch = path.match(/^\/api\/events\/(\d+)\/rsvp$/);
  if (rsvpMatch) {
    const id = Number(rsvpMatch[1]);
    if (method === 'PUT') return setRsvp(request, id, me, env);
    if (method === 'DELETE') return clearRsvp(id, me, env);
    bad(405, 'Methode nicht erlaubt');
  }

  // --- Admin ---
  if (path === '/api/users' && method === 'GET') return listUsers(me, env);
  if (path === '/api/users' && method === 'POST') return createUser(request, me, env);

  const userMatch = path.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === 'DELETE') return deleteUser(Number(userMatch[1]), me, env);

  const resetMatch = path.match(/^\/api\/users\/(\d+)\/tokens$/);
  if (resetMatch && method === 'POST') return resetUserTokens(Number(resetMatch[1]), me, env);

  bad(404, 'Unbekannter Pfad');
}

// ----------------------------------------------------------------------- Auth

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) bad(401, 'Kein Token mitgeschickt');

  const user = await env.DB.prepare(
    'SELECT id, name, color, ics_token, is_admin FROM users WHERE token = ?'
  )
    .bind(token)
    .first();
  if (!user) bad(401, 'Token ungültig – bitte einen neuen Einladungslink anfordern');
  return user;
}

const requireAdmin = (me) => {
  if (!me.is_admin) bad(403, 'Nur für Admins');
};

// ----------------------------------------------------------------- Lesezugriff

async function getState(me, url, env) {
  // Alles ab 180 Tage in der Vergangenheit - reicht als Archiv und hält die Antwort klein.
  const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

  const [users, events, rsvps] = await Promise.all([
    env.DB.prepare('SELECT id, name, color FROM users ORDER BY name COLLATE NOCASE').all(),
    env.DB.prepare(
      'SELECT id, title, starts_at, ends_at, all_day, location, description, created_by' +
        ' FROM events WHERE COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at'
    )
      .bind(since)
      .all(),
    env.DB.prepare(
      'SELECT event_id, user_id, status FROM rsvps' +
        ' WHERE event_id IN (SELECT id FROM events WHERE COALESCE(ends_at, starts_at) >= ?)'
    )
      .bind(since)
      .all(),
  ]);

  const byEvent = new Map();
  for (const r of rsvps.results) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, {});
    byEvent.get(r.event_id)[r.user_id] = r.status;
  }

  return json(
    {
      me: { id: me.id, name: me.name, color: me.color, is_admin: !!me.is_admin },
      palette: PALETTE,
      ics_url: `${url.origin}/ics/${me.ics_token}.ics`,
      users: users.results,
      events: events.results.map((e) => ({
        ...e,
        all_day: !!e.all_day,
        rsvps: byEvent.get(e.id) || {},
      })),
    },
    200,
    env
  );
}

// ------------------------------------------------------------ Eigenes Profil

/** Name und Anzeigefarbe aendern. Jeder darf nur sich selbst bearbeiten. */
async function updateMe(request, me, env) {
  const body = await readJson(request);
  const updates = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) bad(400, 'Der Name darf nicht leer sein');
    if (name.length > 60) bad(400, 'Name ist zu lang (max. 60 Zeichen)');
    updates.name = name;
  }
  if (body.color !== undefined) {
    const color = String(body.color).toLowerCase();
    if (!COLOR_RE.test(color)) bad(400, 'Die Farbe muss ein Hex-Wert wie #1971c2 sein');
    updates.color = color;
  }

  const fields = Object.keys(updates); // feste Whitelist, daher unbedenklich im SQL
  if (!fields.length) bad(400, 'Es wurde nichts zum Ändern mitgeschickt');

  await env.DB.prepare(`UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .bind(...fields.map((f) => updates[f]), me.id)
    .run();
  return json({ ok: true, ...updates }, 200, env);
}

// ----------------------------------------------------------- Events schreiben

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function optionalText(value, max, label) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) bad(400, `${label} ist zu lang (max. ${max} Zeichen)`);
  return text;
}

function parseEventBody(body) {
  const title = String(body.title ?? '').trim();
  if (!title) bad(400, 'Titel fehlt');
  if (title.length > 200) bad(400, 'Titel ist zu lang (max. 200 Zeichen)');

  const allDay = body.all_day ? 1 : 0;
  const pattern = allDay ? DATE_RE : DATETIME_RE;

  const startsAt = String(body.starts_at ?? '');
  if (!pattern.test(startsAt)) bad(400, 'Startzeitpunkt hat ein ungültiges Format');

  const endsAt = body.ends_at ? String(body.ends_at) : null;
  if (endsAt !== null && !pattern.test(endsAt)) bad(400, 'Endzeitpunkt hat ein ungültiges Format');
  // Beide Formate sind lexikografisch sortierbar, deshalb genügt ein String-Vergleich.
  if (endsAt !== null && endsAt < startsAt) bad(400, 'Das Ende liegt vor dem Start');

  return {
    title,
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: allDay,
    location: optionalText(body.location, 200, 'Ort'),
    description: optionalText(body.description, 2000, 'Beschreibung'),
  };
}

async function createEvent(request, me, env) {
  const e = parseEventBody(await readJson(request));
  const row = await env.DB.prepare(
    'INSERT INTO events (title, starts_at, ends_at, all_day, location, description, created_by)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(e.title, e.starts_at, e.ends_at, e.all_day, e.location, e.description, me.id)
    .first();
  return json({ id: row.id }, 201, env);
}

async function loadEditableEvent(id, me, env) {
  const event = await env.DB.prepare('SELECT id, created_by FROM events WHERE id = ?').bind(id).first();
  if (!event) bad(404, 'Veranstaltung nicht gefunden');
  if (event.created_by !== me.id && !me.is_admin) {
    bad(403, 'Nur wer die Veranstaltung angelegt hat (oder ein Admin) darf sie ändern');
  }
  return event;
}

async function updateEvent(request, id, me, env) {
  await loadEditableEvent(id, me, env);
  const e = parseEventBody(await readJson(request));
  await env.DB.prepare(
    'UPDATE events SET title = ?, starts_at = ?, ends_at = ?, all_day = ?, location = ?,' +
      ' description = ?, revision = revision + 1, updated_at = ? WHERE id = ?'
  )
    .bind(e.title, e.starts_at, e.ends_at, e.all_day, e.location, e.description, nowUtc(), id)
    .run();
  return json({ ok: true }, 200, env);
}

async function deleteEvent(id, me, env) {
  await loadEditableEvent(id, me, env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rsvps WHERE event_id = ?').bind(id),
    env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id),
  ]);
  return json({ ok: true }, 200, env);
}

// ------------------------------------------------------------------- Zusagen

async function setRsvp(request, eventId, me, env) {
  const body = await readJson(request);
  const status = String(body.status ?? '');
  if (!STATUSES.includes(status)) bad(400, `Status muss einer von ${STATUSES.join(', ')} sein`);

  const exists = await env.DB.prepare('SELECT 1 FROM events WHERE id = ?').bind(eventId).first();
  if (!exists) bad(404, 'Veranstaltung nicht gefunden');

  await env.DB.prepare(
    'INSERT INTO rsvps (event_id, user_id, status, updated_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at'
  )
    .bind(eventId, me.id, status, nowUtc())
    .run();
  return json({ ok: true }, 200, env);
}

async function clearRsvp(eventId, me, env) {
  await env.DB.prepare('DELETE FROM rsvps WHERE event_id = ? AND user_id = ?').bind(eventId, me.id).run();
  return json({ ok: true }, 200, env);
}

// --------------------------------------------------------------------- Admin

async function listUsers(me, env) {
  requireAdmin(me);
  const { results } = await env.DB.prepare(
    'SELECT id, name, color, token, is_admin, created_at FROM users ORDER BY name COLLATE NOCASE'
  ).all();
  return json({ users: results.map((u) => ({ ...u, is_admin: !!u.is_admin })) }, 200, env);
}

async function createUser(request, me, env) {
  requireAdmin(me);
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  if (!name) bad(400, 'Name fehlt');
  if (name.length > 60) bad(400, 'Name ist zu lang (max. 60 Zeichen)');

  const token = randomToken();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const color = PALETTE[n % PALETTE.length];
  const row = await env.DB.prepare(
    'INSERT INTO users (name, color, token, ics_token, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(name, color, token, randomToken(), body.is_admin ? 1 : 0)
    .first();
  return json({ id: row.id, name, color, token }, 201, env);
}

async function deleteUser(id, me, env) {
  requireAdmin(me);
  if (id === me.id) bad(400, 'Du kannst dich nicht selbst löschen');
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!user) bad(404, 'Person nicht gefunden');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rsvps WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM events WHERE created_by = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return json({ ok: true }, 200, env);
}

/** Erzeugt neue Tokens, falls ein Einladungs- oder Abo-Link in falsche Hände geraten ist. */
async function resetUserTokens(id, me, env) {
  requireAdmin(me);
  const token = randomToken();
  const row = await env.DB.prepare(
    'UPDATE users SET token = ?, ics_token = ? WHERE id = ? RETURNING id, name'
  )
    .bind(token, randomToken(), id)
    .first();
  if (!row) bad(404, 'Person nicht gefunden');
  return json({ id: row.id, name: row.name, token }, 200, env);
}

// ----------------------------------------------------------------- ICS-Feed

async function icsFeed(icsToken, url, env) {
  const user = await env.DB.prepare('SELECT id, name FROM users WHERE ics_token = ?').bind(icsToken).first();
  if (!user) return new Response('Kalender nicht gefunden', { status: 404 });

  // Standard: alles außer ausdrücklichen Absagen. Mit ?only=yes nur die festen Zusagen.
  const onlyYes = url.searchParams.get('only') === 'yes';

  const [eventRows, rsvpRows] = await Promise.all([
    env.DB.prepare(
      'SELECT e.*, r.status AS my_status FROM events e' +
        ' LEFT JOIN rsvps r ON r.event_id = e.id AND r.user_id = ?' +
        ' WHERE COALESCE(r.status, \'\') <> \'no\' ORDER BY e.starts_at'
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      'SELECT r.event_id, r.status, u.name FROM rsvps r JOIN users u ON u.id = r.user_id'
    ).all(),
  ]);

  const names = new Map();
  for (const r of rsvpRows.results) {
    if (!names.has(r.event_id)) names.set(r.event_id, { yes: [], maybe: [], no: [] });
    names.get(r.event_id)[r.status].push(r.name);
  }

  const events = onlyYes ? eventRows.results.filter((e) => e.my_status === 'yes') : eventRows.results;
  const stamp = icsStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freundeskalender//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(env.CALENDAR_NAME || 'Freundeskalender')}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const e of events) {
    const parts = names.get(e.id) || { yes: [], maybe: [], no: [] };
    const notes = [
      e.description,
      parts.yes.length ? `Auf jeden Fall: ${parts.yes.join(', ')}` : null,
      parts.maybe.length ? `Interessiert: ${parts.maybe.join(', ')}` : null,
      parts.no.length ? `Nicht dabei: ${parts.no.join(', ')}` : null,
      `Dein Status: ${{ yes: 'Auf jeden Fall', maybe: 'Interessiert' }[e.my_status] || 'Noch keine Antwort'}`,
    ]
      .filter(Boolean)
      .join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:event-${e.id}@freundeskalender`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`LAST-MODIFIED:${icsStamp(new Date(e.updated_at))}`);
    lines.push(`SEQUENCE:${e.revision}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(e.starts_at)}`);
      // DTEND ist bei Tagesterminen exklusiv → letzter Tag + 1.
      lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(e.ends_at || e.starts_at, 1))}`);
    } else {
      let end = e.ends_at || endeDesTages(e.starts_at);
      // Beginnt der Termin erst kurz vor Mitternacht, waere das Tagesende nicht
      // mehr danach. Dann lieber eine Stunde ansetzen als ein kaputtes DTEND.
      if (Date.parse(end) <= Date.parse(e.starts_at)) {
        end = new Date(Date.parse(e.starts_at) + 3600000).toISOString();
      }
      lines.push(`DTSTART:${icsStamp(new Date(e.starts_at))}`);
      lines.push(`DTEND:${icsStamp(new Date(end))}`);
    }
    lines.push(`SUMMARY:${escapeIcs(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeIcs(e.location)}`);
    if (notes) lines.push(`DESCRIPTION:${escapeIcs(notes)}`);
    lines.push(`STATUS:${e.my_status === 'yes' ? 'CONFIRMED' : 'TENTATIVE'}`);
    lines.push(`TRANSP:${e.my_status === 'yes' ? 'OPAQUE' : 'TRANSPARENT'}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  const body = lines.map(foldIcsLine).join('\r\n') + '\r\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="kalender.ics"',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const compactDate = (isoDate) => isoDate.slice(0, 10).replace(/-/g, '');

function addDays(isoDate, days) {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const escapeIcs = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 erlaubt max. 75 Oktette pro Zeile; Fortsetzungen beginnen mit einem Leerzeichen. */
function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const chunks = [];
  let current = '';
  let bytes = 0;
  let limit = 74;
  for (const char of line) {
    const size = char.codePointAt(0) < 0x80 ? 1 : encoder.encode(char).length;
    if (bytes + size > limit) {
      chunks.push(current);
      current = '';
      bytes = 0;
      limit = 73; // Fortsetzungszeilen verlieren ein Oktett an das führende Leerzeichen.
    }
    current += char;
    bytes += size;
  }
  chunks.push(current);
  return chunks.map((chunk, i) => (i === 0 ? chunk : ` ${chunk}`)).join('\r\n');
}
