/* Freundeskalender - Frontend. Kein Build-Schritt, laeuft direkt auf GitHub Pages. */

const API = (window.KALENDER_API || '').replace(/\/+$/, '');
const TOKEN_KEY = 'kalender.token';
const ZONE = 'Europe/Berlin'; // Alle Zeiten sind Berliner Zeit, egal wo man gerade ist.
const STATUS_LABEL = { yes: 'Auf jeden Fall', maybe: 'Interessiert', no: 'Nicht dabei' };

const el = (id) => document.getElementById(id);
let state = null;
let showPast = false;

// ------------------------------------------------------------------- Zeitzone

const ZONE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Offset der Zone zu UTC in Millisekunden, zum Zeitpunkt `date`. */
function zoneOffset(date) {
  const p = {};
  for (const { type, value } of ZONE_PARTS.formatToParts(date)) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - date.getTime();
}

/** 'YYYY-MM-DDTHH:MM' (Berliner Zeit) -> 'YYYY-MM-DDTHH:MM:SSZ' (UTC) */
function inputToUtc(value) {
  const [date, time] = value.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // Zwei Durchläufe, damit auch die Zeitumstellung korrekt getroffen wird.
  let guess = naive;
  for (let i = 0; i < 2; i++) guess = naive - zoneOffset(new Date(guess));
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 'YYYY-MM-DDTHH:MM:SSZ' (UTC) -> 'YYYY-MM-DDTHH:MM' fuer <input type="datetime-local"> */
function utcToInput(iso) {
  const date = new Date(iso);
  return new Date(date.getTime() + zoneOffset(date)).toISOString().slice(0, 16);
}

const fmt = (opts) => new Intl.DateTimeFormat('de-DE', { timeZone: ZONE, ...opts });
const fmtDay = fmt({ weekday: 'short', day: 'numeric', month: 'long' });
const fmtTime = fmt({ hour: '2-digit', minute: '2-digit' });
const fmtMonth = fmt({ month: 'long', year: 'numeric' });

/** Zeitpunkt, an dem die Veranstaltung vorbei ist (für "vergangen" und Sortierung). */
function endOf(event) {
  if (event.all_day) return Date.parse(`${(event.ends_at || event.starts_at)}T23:59:59Z`);
  return event.ends_at ? Date.parse(event.ends_at) : Date.parse(event.starts_at) + 2 * 3600e3;
}

function describeWhen(event) {
  if (event.all_day) {
    const start = fmtDay.format(new Date(`${event.starts_at}T12:00:00Z`));
    if (!event.ends_at || event.ends_at === event.starts_at) return `${start} · ganztägig`;
    return `${start} – ${fmtDay.format(new Date(`${event.ends_at}T12:00:00Z`))}`;
  }
  const start = new Date(event.starts_at);
  let text = `${fmtDay.format(start)} · ${fmtTime.format(start)}`;
  if (event.ends_at) text += ` – ${fmtTime.format(new Date(event.ends_at))}`;
  return text;
}

function monthKey(event) {
  const date = event.all_day ? new Date(`${event.starts_at}T12:00:00Z`) : new Date(event.starts_at);
  return fmtMonth.format(date);
}

// ------------------------------------------------------------------ API-Zugriff

const getToken = () => localStorage.getItem(TOKEN_KEY) || '';

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Fehler ${response.status}`);
  return data;
}

function note(message) {
  el('status').textContent = message || '';
}

// --------------------------------------------------------------------- Rendern

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderEvents() {
  const now = Date.now();
  const visible = state.events
    .filter((event) => showPast || endOf(event) >= now)
    .sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));

  const container = el('events');
  if (!visible.length) {
    container.innerHTML = '<p class="muted">Noch keine Veranstaltungen. Leg die erste an!</p>';
    return;
  }

  const nameOf = new Map(state.users.map((u) => [String(u.id), u.name]));
  let html = '';
  let currentMonth = null;

  for (const event of visible) {
    const month = monthKey(event);
    if (month !== currentMonth) {
      currentMonth = month;
      html += `<p class="month">${escapeHtml(month)}</p>`;
    }

    const mine = event.rsvps[String(state.me.id)] || '';
    const groups = { yes: [], maybe: [], no: [] };
    for (const [userId, status] of Object.entries(event.rsvps)) {
      if (groups[status]) groups[status].push(nameOf.get(userId) || '?');
    }

    const who = ['yes', 'maybe', 'no']
      .filter((status) => groups[status].length)
      .map((status) =>
        `<div class="k-${status}"><b>${STATUS_LABEL[status]}:</b> ${escapeHtml(groups[status].sort().join(', '))}</div>`)
      .join('');

    const canEdit = event.created_by === state.me.id || state.me.is_admin;

    html += `<article class="event${endOf(event) < now ? ' past' : ''}" data-id="${event.id}">
      <div class="when">${escapeHtml(describeWhen(event))}</div>
      <div class="title">${escapeHtml(event.title)}</div>
      ${event.location ? `<div class="where">📍 ${escapeHtml(event.location)}</div>` : ''}
      ${event.description ? `<div class="notes">${escapeHtml(event.description)}</div>` : ''}
      <div class="rsvp">
        ${['no', 'maybe', 'yes'].map((status) =>
          `<button data-status="${status}" aria-pressed="${mine === status}">${STATUS_LABEL[status]}</button>`).join('')}
      </div>
      <div class="who">${who || 'Noch hat niemand geantwortet.'}</div>
      ${canEdit ? `<div class="event-admin">
        <button data-act="edit">Bearbeiten</button>
        <button data-act="delete">Löschen</button>
      </div>` : ''}
    </article>`;
  }
  container.innerHTML = html;
}

function renderSubscribe() {
  const url = state.ics_url;
  el('ics-url').value = url;
  el('ics-webcal').href = url.replace(/^https?:/, 'webcal:');
}

async function renderAdmin() {
  if (!state.me.is_admin) return;
  el('admin').hidden = false;
  const { users } = await api('/api/users');
  const base = location.origin + location.pathname;
  el('users').innerHTML = users
    .map((user) => `<li data-id="${user.id}">
        <b>${escapeHtml(user.name)}</b>${user.is_admin ? ' <span class="muted small">(Admin)</span>' : ''}
        <div class="invite">
          <input readonly value="${escapeHtml(`${base}#t=${user.token}`)}">
          <button type="button" data-act="copy" class="ghost">Kopieren</button>
          ${user.id === state.me.id ? '' : '<button type="button" data-act="remove" class="ghost">Entfernen</button>'}
        </div>
      </li>`)
    .join('');
}

async function refresh() {
  state = await api('/api/state');
  el('whoami').textContent = state.me.name;
  renderEvents();
  renderSubscribe();
  await renderAdmin();
}

// -------------------------------------------------------------- Event-Handler

el('events').addEventListener('click', async (clickEvent) => {
  const button = clickEvent.target.closest('button');
  if (!button) return;
  const id = Number(button.closest('.event').dataset.id);
  const event = state.events.find((candidate) => candidate.id === id);

  try {
    if (button.dataset.status) {
      // Nochmal auf den aktiven Knopf tippen nimmt die Antwort zurück.
      const active = button.getAttribute('aria-pressed') === 'true';
      if (active) {
        await api(`/api/events/${id}/rsvp`, { method: 'DELETE' });
      } else {
        await api(`/api/events/${id}/rsvp`, {
          method: 'PUT',
          body: JSON.stringify({ status: button.dataset.status }),
        });
      }
      await refresh();
    } else if (button.dataset.act === 'edit') {
      openForm(event);
    } else if (button.dataset.act === 'delete') {
      if (!confirm(`„${event.title}" wirklich löschen?`)) return;
      await api(`/api/events/${id}`, { method: 'DELETE' });
      await refresh();
    }
  } catch (err) {
    note(err.message);
  }
});

function openForm(event) {
  const form = el('event-form');
  form.reset();
  el('event-error').hidden = true;
  if (event) {
    form.elements.id.value = event.id;
    form.elements.title.value = event.title;
    form.elements.all_day.checked = event.all_day;
    form.elements.location.value = event.location || '';
    form.elements.description.value = event.description || '';
    syncAllDay();
    form.elements.start.value = event.all_day ? event.starts_at : utcToInput(event.starts_at);
    form.elements.end.value = !event.ends_at ? '' : event.all_day ? event.ends_at : utcToInput(event.ends_at);
  } else {
    form.elements.id.value = '';
    syncAllDay();
  }
  el('new-event').open = true;
  form.elements.title.focus();
}

/** Ganztägig schaltet die Zeitfelder auf reine Datumsfelder um. */
function syncAllDay() {
  const form = el('event-form');
  const type = form.elements.all_day.checked ? 'date' : 'datetime-local';
  for (const field of [form.elements.start, form.elements.end]) {
    if (field.type !== type) field.value = '';
    field.type = type;
  }
}

el('event-form').elements.all_day.addEventListener('change', syncAllDay);
el('event-cancel').addEventListener('click', () => { el('new-event').open = false; });
el('new-event').addEventListener('toggle', () => {
  if (el('new-event').open && !el('event-form').elements.id.value) openForm(null);
});

el('event-form').addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  const form = submitEvent.target;
  const allDay = form.elements.all_day.checked;
  const errorBox = el('event-error');
  errorBox.hidden = true;

  const payload = {
    title: form.elements.title.value,
    all_day: allDay,
    starts_at: allDay ? form.elements.start.value : inputToUtc(form.elements.start.value),
    ends_at: !form.elements.end.value ? null : allDay ? form.elements.end.value : inputToUtc(form.elements.end.value),
    location: form.elements.location.value,
    description: form.elements.description.value,
  };

  const id = form.elements.id.value;
  try {
    await api(id ? `/api/events/${id}` : '/api/events', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    form.reset();
    form.elements.id.value = '';
    el('new-event').open = false;
    await refresh();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }
});

el('show-past').addEventListener('click', () => {
  showPast = !showPast;
  el('show-past').textContent = showPast ? 'Vergangene ausblenden' : 'Vergangene anzeigen';
  renderEvents();
});

function copyField(input) {
  input.select();
  navigator.clipboard?.writeText(input.value);
  note('Link kopiert.');
}

el('ics-copy').addEventListener('click', () => copyField(el('ics-url')));

el('user-form').addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  const errorBox = el('user-error');
  errorBox.hidden = true;
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: submitEvent.target.elements.name.value }),
    });
    submitEvent.target.reset();
    await refresh();
    note('Angelegt. Den Einladungslink unten kopieren und weitergeben.');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }
});

el('users').addEventListener('click', async (clickEvent) => {
  const button = clickEvent.target.closest('button');
  if (!button) return;
  const item = button.closest('li');
  if (button.dataset.act === 'copy') return copyField(item.querySelector('input'));
  if (button.dataset.act === 'remove') {
    if (!confirm('Person entfernen? Ihre Veranstaltungen und Antworten werden gelöscht.')) return;
    try {
      await api(`/api/users/${item.dataset.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      note(err.message);
    }
  }
});

// ---------------------------------------------------------------------- Start

async function start() {
  if (!API) {
    el('gate').hidden = false;
    el('gate-text').textContent =
      'Noch nicht eingerichtet: trage die Worker-URL in web/config.js ein.';
    return;
  }

  // Token aus dem Einladungslink übernehmen und den Link aus der Adresszeile räumen.
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromLink) {
    localStorage.setItem(TOKEN_KEY, fromLink);
    history.replaceState(null, '', location.pathname + location.search);
  }

  if (!getToken()) {
    el('gate').hidden = false;
    return;
  }

  try {
    await refresh();
    el('app').hidden = false;
  } catch (err) {
    if (/Token/.test(err.message)) localStorage.removeItem(TOKEN_KEY);
    el('gate').hidden = false;
    el('gate-text').textContent = err.message;
  }
}

start();
