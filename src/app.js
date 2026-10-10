import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';

const isNative = Capacitor.isNativePlatform();
const $ = (s) => document.querySelector(s);

/* ---------------- State ---------------- */
const DEFAULTS = { key: '', times: ['08:00', '13:00', '20:30'], model: 'gemini-flash-latest' };
let settings = { ...DEFAULTS };
let items = [];
let lastDeleted = null;

async function load() {
  const s = await Preferences.get({ key: 'settings' });
  const i = await Preferences.get({ key: 'items' });
  try { if (s.value) settings = { ...DEFAULTS, ...JSON.parse(s.value) }; } catch {}
  try { if (i.value) items = JSON.parse(i.value); } catch {}
}
const saveItems = () => Preferences.set({ key: 'items', value: JSON.stringify(items) });
const saveSettings = () => Preferences.set({ key: 'settings', value: JSON.stringify(settings) });

/* ---------------- Dates ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function tzOffset() {
  const m = -new Date().getTimezoneOffset();
  return `${m >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
}
function localIso(d) {
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${tzOffset()}`;
}
function niceDay(str) {
  const t = todayStr();
  if (str === t) return 'Today';
  if (str === ymd(addDays(new Date(), 1))) return 'Tomorrow';
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
const niceTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/* ---------------- Gemini ---------------- */
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          existing_id: { type: 'STRING', nullable: true },
          update: { type: 'STRING', nullable: true },
          status: { type: 'STRING', enum: ['open', 'done'] },
          text: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['follow-up', 'to-do', 'keep in mind'] },
          person: { type: 'STRING', nullable: true },
          context: { type: 'STRING', nullable: true },
          start_date: { type: 'STRING' },
          remind_at: { type: 'STRING', nullable: true },
        },
        required: ['text', 'kind', 'start_date', 'status'],
      },
    },
  },
  required: ['transcript', 'items'],
};

// What Gemini sees of the current list, so new recordings can update old items.
function knownItems() {
  const cutoff = ymd(addDays(new Date(), -21));
  const pool = items.filter((i) => !i.done || (i.doneAt || '').slice(0, 10) >= cutoff).slice(0, 80);
  if (!pool.length) return 'None yet.';
  return pool.map((i) => {
    const hist = (i.history || []).slice(-3).map((h) => `${h.at.slice(0, 10)}: ${h.note}`).join(' | ');
    return `- id=${i.id} [${i.done ? 'done' : 'open'}, ${i.kind}${i.person ? `, about ${i.person}` : ''}, created ${i.createdAt.slice(0, 10)}] ${i.text}` +
      (i.context ? ` (detail: ${i.context})` : '') + (hist ? ` (updates: ${hist})` : '');
  }).join('\n');
}

function prompt(isAudio) {
  const now = new Date();
  return `You turn a ${isAudio ? 'voice memo' : 'quick note'} into reminder items for the person speaking, and keep his existing items up to date.
Right now it is ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${pad(now.getHours())}:${pad(now.getMinutes())} local time (UTC${tzOffset()}). Today's date is ${todayStr()}.

He usually records this right after a conversation (often with his wife) or when something crosses his mind. He wants to remember to follow up, show he was listening, and not drop things. Stories develop over days, so he will often give updates on things he mentioned before.

His current items:
${knownItems()}

For every distinct thing in what he says, return one entry:
- existing_id: if it is news about, or a continuation of, one of his current items (same person and same topic, even if worded differently, e.g. "the interview" / "her job thing"), the id of that item. Otherwise null. Never create a new entry for something that matches an existing item.
- update: when existing_id is set, one short line saying what's new, in his terms (e.g. "Interview went well, she's waiting to hear back by Friday"). Otherwise null.
- status: "done" only if the matter is fully resolved and there is nothing left to follow up on; otherwise "open".
- text: the next thing to remember or do, short and actionable, written as a note to himself, under 90 characters. For an update, rewrite it to the new next step (e.g. "Ask if she's heard back about the job"). Keep names and nicknames exactly as he said them.
- kind: "follow-up" (check in with or ask someone about something), "to-do" (something to do), or "keep in mind" (a fact or detail to remember, e.g. a preference or date).
- person: who it is about, as he referred to them, or null. For an update, keep the existing item's person unless he says otherwise.
- context: one short line of the most useful current detail (time, place, why it matters), or null.
- start_date: YYYY-MM-DD for when the next nudges should begin. Default today. If the next step only makes sense after an event or a date he mentions, use that date. Resolve "tomorrow", "next week", "on Friday" to a date.
- remind_at: full ISO 8601 local datetime with offset (e.g. ${localIso(addDays(now, 1)).slice(0, 11)}09:00:00${tzOffset()}) ONLY if he gave or clearly implied a specific time ("at 3pm", "after her 10am interview" -> shortly after 10am, "tomorrow morning" -> 09:00). Otherwise null.

Ignore filler and repetition. Do not invent items or updates. Leave untouched any existing item he does not mention. If nothing is worth saving, return an empty items list.
Also return "transcript": a clean, lightly punctuated transcript of what he said.`;
}

async function callGemini(parts, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key.trim() },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return JSON.parse(text);
}

async function understand(parts) {
  if (!settings.key.trim()) throw new Error('Add your Gemini API key in Settings first.');
  try {
    return await callGemini(parts, settings.model || DEFAULTS.model);
  } catch (e) {
    // If the chosen model name is gone, fall back once to a known one.
    if (e.status === 404 && settings.model !== 'gemini-2.5-flash') return await callGemini(parts, 'gemini-2.5-flash');
    throw e;
  }
}

const KINDS = ['follow-up', 'to-do', 'keep in mind'];

// Applies Gemini's result: updates matched items, adds new ones. Returns what changed plus an undo.
function applyResult(result, source) {
  const t = todayStr();
  const nowIso = new Date().toISOString();
  const transcript = result.transcript || source || '';
  const created = [];
  const before = new Map(); // id -> copy of item before this change

  for (const r of result.items || []) {
    if (!r.text) continue;
    let remindAt = null;
    if (r.remind_at) { const d = new Date(r.remind_at); if (!isNaN(d)) remindAt = d.toISOString(); }
    let start = /^\d{4}-\d{2}-\d{2}$/.test(r.start_date || '') ? r.start_date : t;
    if (remindAt) { const rd = ymd(new Date(remindAt)); if (rd < start) start = rd; }
    if (start < t) start = t;
    const done = r.status === 'done';

    const existing = r.existing_id && items.find((i) => i.id === r.existing_id);
    if (existing) {
      if (!before.has(existing.id)) before.set(existing.id, JSON.parse(JSON.stringify(existing)));
      if (!existing.origin) existing.origin = existing.context ? `${existing.text} (${existing.context})` : existing.text;
      existing.history = [...(existing.history || []), { at: nowIso, note: (r.update || r.context || r.text).trim() }];
      existing.text = r.text.trim();
      if (KINDS.includes(r.kind)) existing.kind = r.kind;
      if (r.person) existing.person = r.person;
      existing.context = r.context || null;
      existing.startDate = start;
      existing.remindAt = remindAt;
      existing.done = done;
      existing.doneAt = done ? nowIso : null;
      existing.updatedAt = nowIso;
      continue;
    }
    created.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      text: r.text.trim(),
      kind: KINDS.includes(r.kind) ? r.kind : 'to-do',
      person: r.person || null,
      context: r.context || null,
      startDate: start,
      remindAt,
      done,
      doneAt: done ? nowIso : null,
      createdAt: nowIso,
      history: [],
      origin: r.context ? `${r.text.trim()} (${r.context})` : r.text.trim(),
      transcript,
    });
  }
  items = [...created, ...items];
  // Updated items move to the top so they're easy to spot.
  if (before.size) items = [...items.filter((i) => before.has(i.id)), ...items.filter((i) => !before.has(i.id))];

  const undo = () => {
    const ids = new Set(created.map((c) => c.id));
    items = items.filter((i) => !ids.has(i.id)).map((i) => before.get(i.id) || i);
  };
  return { created: created.length, updated: before.size, undo };
}

function changeSummary({ created, updated }) {
  const parts = [];
  if (created) parts.push(`Added ${created}`);
  if (updated) parts.push(`Updated ${updated}`);
  return parts.join(' · ');
}

/* ---------------- Recording (WAV, 16 kHz mono) ---------------- */
let rec = null;

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  rec = { stream, ctx, src, proc, chunks, started: Date.now() };
}

async function stopRecording() {
  if (!rec) return null;
  const { stream, ctx, src, proc, chunks } = rec;
  rec = null;
  src.disconnect(); proc.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const rate = ctx.sampleRate;
  await ctx.close();
  const len = chunks.reduce((n, c) => n + c.length, 0);
  if (len < rate * 0.8) return null; // under ~1 second: treat as accidental tap
  return encodeWav(chunks, len, rate);
}

function encodeWav(chunks, len, rate) {
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, c[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------------- Notifications ---------------- */
const SLOTS = [
  { title: 'Morning check-in' },
  { title: 'Afternoon check-in' },
  { title: 'Tonight, before you sleep' },
];
const DAYS_AHEAD = 7;

function activeOn(dateStr) {
  return items.filter((i) => !i.done && i.startDate <= dateStr);
}

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 100000 + (Math.abs(h) % 1000000000);
}

async function reschedule() {
  if (!isNative) return;
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });

    const list = [];
    const now = new Date();
    for (let d = 0; d < DAYS_AHEAD; d++) {
      const day = addDays(now, d);
      const ds = ymd(day);
      const act = activeOn(ds);
      settings.times.forEach((t, slot) => {
        const [hh, mm] = (t || '08:00').split(':').map(Number);
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
        if (at <= now || !act.length) return;
        const lines = act.slice(0, 7).map((i) => `• ${i.text}`);
        if (act.length > 7) lines.push(`+ ${act.length - 7} more`);
        list.push({
          id: 1000 + d * 10 + slot,
          title: SLOTS[slot].title,
          body: act.length === 1 ? act[0].text : `${act[0].text} (+${act.length - 1} more)`,
          largeBody: lines.join('\n'),
          summaryText: `${act.length} to remember`,
          channelId: 'nudges',
          schedule: { at, allowWhileIdle: true },
        });
      });
    }
    for (const i of items) {
      if (i.done || !i.remindAt) continue;
      const at = new Date(i.remindAt);
      if (at <= now) continue;
      list.push({
        id: hashId(i.id),
        title: i.person ? `About ${i.person}` : 'Reminder',
        body: i.text,
        largeBody: i.context ? `${i.text}\n${i.context}` : i.text,
        channelId: 'nudges',
        schedule: { at, allowWhileIdle: true },
      });
    }
    if (list.length) await LocalNotifications.schedule({ notifications: list });
  } catch (e) {
    console.error('reschedule failed', e);
  }
}

async function setupNotifications() {
  if (!isNative) return;
  try {
    await LocalNotifications.createChannel({ id: 'nudges', name: 'Nudges', description: 'Daily check-ins and reminders', importance: 4, visibility: 1, vibration: true });
    await LocalNotifications.requestPermissions();
  } catch (e) { console.error(e); }
}

/* ---------------- Rendering ---------------- */
const KIND_CLASS = { 'follow-up': 'follow-up', 'to-do': 'to-do', 'keep in mind': 'keep' };
const KIND_LABEL = { 'follow-up': 'Follow up', 'to-do': 'To do', 'keep in mind': 'Keep in mind' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shortDay(iso) {
  const d = ymd(new Date(iso));
  if (d === todayStr()) return 'Today';
  if (d === ymd(addDays(new Date(), -1))) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function latestUpdate(i) {
  const h = i.history || [];
  if (!h.length) return '';
  const last = h[h.length - 1];
  const more = h.length > 1 ? ` · ${h.length} updates` : '';
  return `<button class="update" data-act="edit"><span class="update-day">${shortDay(last.at)}${more}</span>${esc(last.note)}</button>`;
}

function cardHtml(i) {
  const chips = [`<span class="chip ${KIND_CLASS[i.kind] || ''}">${KIND_LABEL[i.kind] || i.kind}</span>`];
  if (i.person) chips.push(`<span class="chip">${esc(i.person)}</span>`);
  if (i.remindAt) chips.push(`<span class="chip time">${ymd(new Date(i.remindAt)) === todayStr() ? '' : niceDay(ymd(new Date(i.remindAt))) + ' · '}${niceTime(i.remindAt)}</span>`);
  return `<article class="card${i.done ? ' done' : ''}" data-id="${i.id}">
    <button class="check" data-act="toggle" aria-label="${i.done ? 'Mark not done' : 'Mark done'}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
    </button>
    <div class="card-body">
      <p class="text">${esc(i.text)}</p>
      ${i.context ? `<p class="context">${esc(i.context)}</p>` : ''}
      ${latestUpdate(i)}
      <div class="meta">${chips.join('')}</div>
    </div>
    <button class="more" data-act="edit" aria-label="Edit">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
    </button>
  </article>`;
}

function render() {
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#setup-banner').hidden = !!settings.key.trim();

  const t = todayStr();
  const open = items.filter((i) => !i.done);
  const now = open.filter((i) => i.startDate <= t).sort((a, b) => (a.remindAt || 'z').localeCompare(b.remindAt || 'z'));
  const later = open.filter((i) => i.startDate > t).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const done = items.filter((i) => i.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));

  if (!items.length) {
    $('#list').innerHTML = `<div class="empty"><h2>Nothing to remember yet</h2><p>After a conversation, tap the mic and just talk. Nudge sorts it out and checks in with you morning, afternoon and night.</p></div>`;
    return;
  }

  let html = '';
  html += `<section class="group"><div class="group-head"><h2>On your mind today</h2><span class="count">${now.length}</span></div>${
    now.length ? now.map(cardHtml).join('') : `<p class="context" style="margin:0 2px">All clear for today.</p>`}</section>`;

  if (later.length) {
    const byDay = {};
    later.forEach((i) => (byDay[i.startDate] ||= []).push(i));
    for (const [d, list] of Object.entries(byDay)) {
      html += `<section class="group"><div class="group-head"><h2>${niceDay(d)}</h2><span class="count">${list.length}</span></div>${list.map(cardHtml).join('')}</section>`;
    }
  }
  if (done.length) {
    html += `<section class="group"><div class="group-head"><h2>Done</h2><button class="text-btn" data-act="clear-done">Clear ${done.length}</button></div>${done.slice(0, 20).map(cardHtml).join('')}</section>`;
  }
  $('#list').innerHTML = html;
}

async function commit() {
  await saveItems();
  render();
  await reschedule();
}

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, actionLabel, action) {
  $('#toast-msg').textContent = msg;
  const btn = $('#toast-action');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = async () => { $('#toast').hidden = true; await action?.(); };
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), actionLabel ? 6000 : 3500);
}

/* ---------------- Capture flow ---------------- */
let timerInt;
async function beginCapture() {
  if (!settings.key.trim()) { openSettings(); toast('Add your Gemini key first'); return; }
  try {
    await startRecording();
  } catch (e) {
    toast('Microphone permission is needed to record');
    return;
  }
  const ov = $('#rec');
  ov.hidden = false; ov.classList.remove('busy');
  $('#rec-state').textContent = 'Listening';
  $('#rec-hint').textContent = 'Talk it through. Who, what, and when if it matters.';
  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    if (s >= 300) finishCapture(); // 5-minute cap
  };
  tick(); timerInt = setInterval(tick, 250);
}

async function finishCapture() {
  clearInterval(timerInt);
  const ov = $('#rec');
  ov.classList.add('busy');
  $('#rec-state').textContent = 'Sorting it out';
  $('#rec-hint').textContent = 'Pulling out what to remember…';
  const b64 = await stopRecording();
  if (!b64) { ov.hidden = true; toast('That was too short. Hold on a little longer.'); return; }
  try {
    const result = await understand([{ text: prompt(true) }, { inline_data: { mime_type: 'audio/wav', data: b64 } }]);
    const change = applyResult(result);
    ov.hidden = true;
    await commit();
    if (change.created || change.updated) toast(changeSummary(change), 'Undo', async () => { change.undo(); await commit(); });
    else toast("Didn't catch anything to save");
  } catch (e) {
    ov.hidden = true;
    toast(friendlyError(e));
  }
}

async function cancelCapture() {
  clearInterval(timerInt);
  await stopRecording();
  $('#rec').hidden = true;
}

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/api key|API_KEY|permission|403|400/i.test(m) && /key/i.test(m)) return 'Gemini key looks wrong. Check it in Settings.';
  if (/quota|429|rate/i.test(m)) return 'Gemini is busy or over the free limit. Try again in a minute.';
  if (/fetch|network|Failed/i.test(m)) return 'No connection. Try again when you are online.';
  return m.length > 120 ? m.slice(0, 117) + '…' : m;
}

/* ---------------- Sheets ---------------- */
function openSheet(id) { $('#toast').hidden = true; $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true)); }

function openSettings() {
  $('#set-key').value = settings.key;
  settings.times.forEach((t, n) => ($(`#set-t${n}`).value = t));
  $('#set-model').value = settings.model;
  openSheet('#settings');
}

let editingId = null;
function openItem(id) {
  const i = items.find((x) => x.id === id);
  if (!i) return;
  editingId = id;
  $('#item-edit').value = i.text;
  $('#item-date').value = i.startDate;
  $('#item-at').value = i.remindAt ? localIso(new Date(i.remindAt)).slice(0, 16) : '';
  const story = [{ at: i.createdAt, note: `First noted: ${i.origin || i.text}` }, ...(i.history || [])];
  $('#item-history').innerHTML = story.length > 1
    ? `<h3>How this has developed</h3><ol class="timeline">${story.map((h) => `<li><span>${shortDay(h.at)}</span>${esc(h.note)}</li>`).join('')}</ol>`
    : '';
  openSheet('#item-sheet');
}

/* ---------------- Wire up ---------------- */
function bind() {
  $('#mic-btn').onclick = beginCapture;
  $('#rec-stop').onclick = finishCapture;
  $('#rec-cancel').onclick = cancelCapture;
  $('#open-settings').onclick = openSettings;
  $('#banner-settings').onclick = openSettings;
  $('#type-btn').onclick = () => { $('#type-input').value = ''; openSheet('#type-sheet'); setTimeout(() => $('#type-input').focus(), 50); };

  document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => {
    if (e.target === s || e.target.closest('[data-close]')) closeSheets();
  }));

  $('#type-send').onclick = async () => {
    const txt = $('#type-input').value.trim();
    if (!txt) return;
    const btn = $('#type-send');
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      const result = await understand([{ text: `${prompt(false)}\n\nThe note:\n${txt}` }]);
      const change = applyResult(result, txt);
      closeSheets();
      await commit();
      if (change.created || change.updated) toast(changeSummary(change), 'Undo', async () => { change.undo(); await commit(); });
      else toast("Didn't find anything to save");
    } catch (e) { toast(friendlyError(e)); }
    btn.disabled = false; btn.textContent = 'Add';
  };

  $('#list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'clear-done') {
      const removed = items.filter((i) => i.done);
      items = items.filter((i) => !i.done);
      await commit();
      toast(`Cleared ${removed.length}`, 'Undo', async () => { items = [...items, ...removed]; await commit(); });
      return;
    }
    const id = btn.closest('.card')?.dataset.id;
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (btn.dataset.act === 'toggle') {
      it.done = !it.done; it.doneAt = it.done ? new Date().toISOString() : null;
      await commit();
    } else if (btn.dataset.act === 'edit') openItem(id);
  });

  $('#item-save').onclick = async () => {
    const it = items.find((x) => x.id === editingId);
    if (!it) return closeSheets();
    it.text = $('#item-edit').value.trim() || it.text;
    it.startDate = $('#item-date').value || it.startDate;
    const at = $('#item-at').value;
    it.remindAt = at ? new Date(at).toISOString() : null;
    closeSheets(); await commit();
  };
  $('#item-tomorrow').onclick = async () => {
    const it = items.find((x) => x.id === editingId);
    if (it) { it.startDate = ymd(addDays(new Date(), 1)); if (it.remindAt && new Date(it.remindAt) < new Date()) it.remindAt = null; }
    closeSheets(); await commit(); toast('Moved to tomorrow');
  };
  $('#item-delete').onclick = async () => {
    const idx = items.findIndex((x) => x.id === editingId);
    if (idx < 0) return closeSheets();
    lastDeleted = { item: items[idx], idx };
    items.splice(idx, 1);
    closeSheets(); await commit();
    toast('Deleted', 'Undo', async () => { items.splice(lastDeleted.idx, 0, lastDeleted.item); await commit(); });
  };

  $('#set-save').onclick = async () => {
    settings.key = $('#set-key').value.trim();
    settings.times = [0, 1, 2].map((n) => $(`#set-t${n}`).value || DEFAULTS.times[n]);
    settings.model = $('#set-model').value.trim() || DEFAULTS.model;
    await saveSettings();
    closeSheets(); render(); await reschedule();
    toast('Saved');
  };
  $('#set-exact').onclick = async () => {
    if (!isNative) return toast('Only on the phone');
    try {
      const s = await LocalNotifications.checkExactNotificationSetting();
      if (s.exact_alarm === 'granted') return toast('On-time alerts are already allowed');
      await LocalNotifications.changeExactNotificationSetting();
    } catch { toast('Not needed on this phone'); }
  };
  $('#set-test').onclick = async () => {
    if (!isNative) return toast('Only on the phone');
    await setupNotifications();
    await LocalNotifications.schedule({ notifications: [{ id: 999, title: 'Nudge works', body: 'This is how your check-ins will look.', channelId: 'nudges', schedule: { at: new Date(Date.now() + 3000), allowWhileIdle: true } }] });
    toast('Sending in 3 seconds');
  };

  App.addListener('appStateChange', ({ isActive }) => { if (isActive) { render(); reschedule(); } });
}

(async function init() {
  await load();
  bind();
  render();
  await setupNotifications();
  await reschedule();
})();
