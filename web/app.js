/* Freundeskalender - Frontend. Kein Build-Schritt, laeuft direkt auf GitHub Pages. */

const API = (window.KALENDER_API || '').replace(/\/+$/, '');
const TOKEN_KEY = 'kalender.token';
const ZONE = 'Europe/Berlin'; // Alle Zeiten sind Berliner Zeit, egal wo man gerade ist.
const STATUS_LABEL = { yes: 'Auf jeden Fall', maybe: 'Interessiert', no: 'Nicht dabei' };

const el = (id) => document.getElementById(id);

/** Schwarze oder weisse Schrift - je nachdem, was auf der Farbe besser lesbar ist. */
function textOn(hex) {
  const value = parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.42 ? '#1c1b19' : '#ffffff';
}

/**
 * Kuerzel fuer die Kreise: normalerweise ein Buchstabe. Waeren zwei Personen
 * damit nicht unterscheidbar (Karla/Konst), waechst es so weit wie noetig.
 */
function shortNamesFor(users) {
  const short = new Map();
  for (const user of users) {
    const name = (user.name || '?').trim() || '?';
    let length = 1;
    const collides = (len) => users.some((other) =>
      other.id !== user.id &&
      (other.name || '').trim().slice(0, len).toLowerCase() === name.slice(0, len).toLowerCase());
    while (length < name.length && collides(length)) length++;
    short.set(String(user.id), name.slice(0, length));
  }
  return short;
}

/** Runder Kreis mit Kuerzel in der Wunschfarbe der Person. */
function avatar(user, extraClass = '') {
  const color = user.color || '#495057';
  const label = escapeHtml(user.name);
  return `<span class="avatar ${extraClass}" style="background:${color};color:${textOn(color)}"` +
    ` title="${label}" aria-label="${label}">${escapeHtml(shortNames.get(String(user.id)) || '?')}</span>`;
}

/** Adressen im Text anklickbar machen. Laeuft auf bereits maskiertem HTML. */
function linkify(escapedText) {
  return escapedText.replace(/\b(?:https?:\/\/|www\.)[^\s]+/gi, (match) => {
    let address = match;
    // Maskierte Anfuehrungs- und Klammerzeichen beenden die Adresse.
    const stop = address.search(/&quot;|&#39;|&lt;|&gt;/);
    if (stop > -1) address = address.slice(0, stop);
    address = address.replace(/[.,;:!?]+$/, '');              // Satzzeichen am Satzende
    const count = (char) => address.split(char).length - 1;
    while (address.endsWith(')') && count(')') > count('(')) address = address.slice(0, -1);
    if (!address) return match;

    const href = address.startsWith('www.') ? `https://${address}` : address;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${address}</a>` +
      match.slice(address.length);
  });
}
let state = null;
let showPast = false;
let shortNames = new Map();

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

  const nameOf = new Map(state.users.map((u) => [String(u.id), u]));
  let html = '';
  let currentMonth = null;

  for (const event of visible) {
    const month = monthKey(event);
    if (month !== currentMonth) {
      currentMonth = month;
      html += `<p class="month">${escapeHtml(month)}</p>`;
    }

    const mine = event.rsvps[String(state.me.id)] || '';
    const groups = { no: [], maybe: [], yes: [] };
    for (const [userId, status] of Object.entries(event.rsvps)) {
      const user = nameOf.get(userId);
      if (groups[status] && user) groups[status].push(user);
    }
    for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name, 'de'));

    // Ampel-Reihenfolge: rot, gelb, gruen - immer gleich, damit die Position die Bedeutung traegt.
    const order = ['no', 'maybe', 'yes'];
    const buttons = order.map((status) =>
      `<button class="s-${status}" data-status="${status}" aria-pressed="${mine === status}"` +
      ` title="${STATUS_LABEL[status]}" aria-label="${STATUS_LABEL[status]}"></button>`).join('');
    const columns = order.map((status) =>
      `<div class="col">${groups[status].map((user) => avatar(user)).join('')}</div>`).join('');
    const nobody = order.every((status) => !groups[status].length);

    const canEdit = event.created_by === state.me.id || state.me.is_admin;

    html += `<article class="event${endOf(event) < now ? ' past' : ''}" data-id="${event.id}">
      <div class="when">${escapeHtml(describeWhen(event))}</div>
      <div class="title">${escapeHtml(event.title)}</div>
      ${event.location ? `<div class="where">📍 ${escapeHtml(event.location)}</div>` : ''}
      ${event.description ? `<div class="notes">${linkify(escapeHtml(event.description))}</div>` : ''}
      <div class="rsvp">${buttons}${columns}</div>
      ${nobody ? '<div class="who muted">Noch hat niemand geantwortet.</div>' : ''}
      ${canEdit ? `<div class="event-admin">
        <button data-act="edit">Bearbeiten</button>
        <button data-act="delete">Löschen</button>
      </div>` : ''}
    </article>`;
  }
  container.innerHTML = html;
}

function renderProfile() {
  el('profile-form').elements.name.value = state.me.name;

  const palette = state.palette || [];
  const chosen = (state.me.color || '').toLowerCase();
  el('palette').innerHTML = palette
    .map((color) => `<button type="button" class="swatch" data-color="${color}"` +
      ` style="background:${color}" aria-pressed="${color === chosen}"` +
      ` title="${color}" aria-label="Farbe ${color}"></button>`)
    .join('');

  // Der eigene Einladungslink ist das Token im Browser - kein API-Aufruf noetig.
  el('my-link').value = `${location.origin}${location.pathname}#t=${getToken()}`;

  const color = state.me.color || '#495057';
  const me = el('whoami');
  me.textContent = shortNames.get(String(state.me.id)) || state.me.name.slice(0, 1);
  me.style.background = color;
  me.style.color = textOn(color);
  me.title = `${state.me.name} - Profil öffnen`;
  me.setAttribute('aria-label', me.title);
  me.hidden = false;
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
        ${avatar(user)} <b>${escapeHtml(user.name)}</b>${user.is_admin ? ' <span class="muted small">(Admin)</span>' : ''}
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
  shortNames = shortNamesFor(state.users);
  renderProfile();
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

el('whoami').addEventListener('click', () => {
  el('profile').open = true;
  el('profile').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

el('ics-copy').addEventListener('click', () => copyField(el('ics-url')));
el('my-link-copy').addEventListener('click', () => copyField(el('my-link')));

// Farbwahl wirkt sofort in der Vorschau; gespeichert wird erst beim Absenden.
el('palette').addEventListener('click', (clickEvent) => {
  const swatch = clickEvent.target.closest('.swatch');
  if (!swatch) return;
  for (const other of el('palette').children) {
    other.setAttribute('aria-pressed', String(other === swatch));
  }
  el('whoami').style.background = swatch.dataset.color;
  el('whoami').style.color = textOn(swatch.dataset.color);
});

// Zuklappen ohne Speichern verwirft die Vorschau wieder.
el('profile').addEventListener('toggle', () => {
  if (!el('profile').open) {
    el('profile-error').hidden = true;
    renderProfile();
  }
});

el('profile-form').addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  const errorBox = el('profile-error');
  errorBox.hidden = true;
  const picked = el('palette').querySelector('[aria-pressed="true"]');
  try {
    await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: submitEvent.target.elements.name.value,
        color: picked ? picked.dataset.color : state.me.color,
      }),
    });
    await refresh();
    el('profile').open = false;
    note('Profil gespeichert.');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }
});

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
