import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Mp3Encoder } from '@breezystack/lamejs';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { CapacitorCalendar } from '@ebarooni/capacitor-calendar';

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
          event_at: { type: 'STRING', nullable: true },
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
${calendarContext()}
For every distinct thing in what he says, return one entry:
- existing_id: if it is news about, or a continuation of, one of his current items (same person and same topic, even if worded differently, e.g. "the interview" / "her job thing"), the id of that item. Otherwise null. Never create a new entry for something that matches an existing item.
- update: when existing_id is set, one short line saying what's new, in his terms (e.g. "Interview went well, she's waiting to hear back by Friday"). Otherwise null.
- status: "done" only if the matter is fully resolved and there is nothing left to follow up on; otherwise "open".
- text: the next thing to remember or do, short and actionable, written as a note to himself, under 90 characters. For an update, rewrite it to the new next step (e.g. "Ask if she's heard back about the job"). Keep names and nicknames exactly as he said them.
- kind: "follow-up" (check in with or ask someone about something), "to-do" (something to do), or "keep in mind" (a fact or detail to remember, e.g. a preference or date).
- person: who it is about, as he referred to them, or null. For an update, keep the existing item's person unless he says otherwise.
- context: one short line of the most useful current detail (time, place, why it matters), or null.
- start_date: YYYY-MM-DD for when the next nudges should begin. Default today. If the next step only makes sense after an event or a date he mentions, use that date. Resolve "tomorrow", "next week", "on Friday" to a date.
- remind_at: full ISO 8601 local datetime with offset (e.g. ${localIso(addDays(now, 1)).slice(0, 11)}09:00:00${tzOffset()}) ONLY if he gave or clearly implied a specific time ("at 3pm", "after her 10am interview" -> shortly after 10am, "tomorrow morning" -> 09:00, "after my 2pm call" -> use his calendar). Otherwise null.
- event_at: ONLY for something of his own that happens at a set time (his interview, meeting, appointment, call, class), the ISO 8601 local datetime it starts, with offset. This goes on his calendar. Null for follow-ups about other people's events, tasks without a fixed time, and anything already on his calendar.

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

// Never wait forever: if Gemini hasn't answered in time, give up so the user can retry.
function withTimeout(promise, ms, msg) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(msg), { timeout: true })), ms); })])
    .finally(() => clearTimeout(t));
}

async function understand(parts, ms = 120000) {
  if (!settings.key.trim()) throw new Error('Add your Gemini API key in Settings first.');
  const once = (model) => withTimeout(callGemini(parts, model), ms, 'Gemini took too long to answer. Check your connection and try again.');
  try {
    return await once(settings.model || DEFAULTS.model);
  } catch (e) {
    // If the chosen model name is gone, fall back once to a known one.
    if (e.status === 404 && settings.model !== 'gemini-2.5-flash') return await once('gemini-2.5-flash');
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
    let eventAt = null;
    if (r.event_at) { const d = new Date(r.event_at); if (!isNaN(d)) eventAt = d.toISOString(); }
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
      if (eventAt || r.event_at === null) existing.eventAt = eventAt;
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
      eventAt,
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

/* ---------------- Recording (16 kHz mono, MP3 for small uploads) ----------------
   A session collects audio across one or more mic segments, so a recording interrupted by the
   screen turning off or a call can be paused and continued instead of being sent half-finished. */
let session = null; // { chunks, rate, elapsed (ms before current segment), segStart, live }
const MAX_MS = 10 * 60 * 1000;

const sessionMs = () => (session ? session.elapsed + (session.live ? Date.now() - session.segStart : 0) : 0);

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  if (!session) session = { chunks: [], rate: ctx.sampleRate, elapsed: 0 };
  const chunks = session.chunks;
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  session.live = { stream, ctx, src, proc };
  session.segStart = Date.now();
  stayAwake(true);
}

async function stopMic() {
  if (!session?.live) return;
  const { stream, ctx, src, proc } = session.live;
  session.elapsed += Date.now() - session.segStart;
  session.live = null;
  try { src.disconnect(); proc.disconnect(); } catch {}
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close().catch(() => {});
  stayAwake(false);
}

// Keeps the screen on while recording, so the phone doesn't sleep mid-sentence.
let webLock = null;
async function stayAwake(on) {
  try {
    if (isNative) { on ? await KeepAwake.keepAwake() : await KeepAwake.allowSleep(); return; }
    if (on && navigator.wakeLock) webLock = await navigator.wakeLock.request('screen');
    else if (!on && webLock) { await webLock.release(); webLock = null; }
  } catch (e) { console.warn('keep awake', e); }
}

function sessionPcm() {
  const len = session.chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(len);
  let o = 0;
  for (const c of session.chunks) for (let i = 0; i < c.length; i++, o++) {
    const v = Math.max(-1, Math.min(1, c[i]));
    pcm[o] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm;
}

// Ends the session and returns encoded audio, or null if it was too short.
async function stopRecording() {
  if (!session) return null;
  await stopMic();
  const rate = session.rate;
  const pcm = sessionPcm();
  session = null;
  await clearDraft();
  if (pcm.length < rate * 0.8) return null; // under ~1 second: treat as accidental tap
  const seconds = Math.round(pcm.length / rate);
  try {
    return { data: toBase64(encodeMp3(pcm, rate)), mime: 'audio/mp3', seconds };
  } catch (e) {
    console.error('mp3 encode failed, using wav', e);
    return { data: toBase64(encodeWav(pcm, rate)), mime: 'audio/wav', seconds };
  }
}

/* A paused recording is also written to the phone, so it survives Android closing the app. */
const DRAFT_FILE = 'draft.pcm';
async function saveDraft() {
  if (!session) return;
  try {
    const pcm = sessionPcm();
    await Filesystem.writeFile({ path: DRAFT_FILE, data: toBase64(new Uint8Array(pcm.buffer)), directory: Directory.Data });
    await Preferences.set({ key: 'draft', value: JSON.stringify({ rate: session.rate, elapsed: session.elapsed }) });
  } catch (e) { console.error('save draft', e); }
}
async function clearDraft() {
  await Preferences.remove({ key: 'draft' }).catch(() => {});
  await Filesystem.deleteFile({ path: DRAFT_FILE, directory: Directory.Data }).catch(() => {});
}
async function loadDraft() {
  try {
    const meta = (await Preferences.get({ key: 'draft' })).value;
    if (!meta) return false;
    const { rate, elapsed } = JSON.parse(meta);
    const b64 = (await Filesystem.readFile({ path: DRAFT_FILE, directory: Directory.Data })).data;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
    session = { chunks: [f], rate, elapsed, live: null };
    return true;
  } catch (e) {
    console.error('load draft', e);
    await clearDraft();
    return false;
  }
}

function encodeMp3(pcm, rate) {
  const enc = new Mp3Encoder(1, rate, 32); // 32 kbps mono: ~240 KB per minute, plenty for speech
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (out.length) parts.push(out);
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return bytes;
}

function encodeWav(pcm, rate) {
  const len = pcm.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------------- Saved recordings queue ----------------
   Every recording is written to the phone before it is sent, so nothing is lost if the app is
   minimised, closed by Android, or offline. Unfinished ones are retried when the app opens. */
let jobs = [];
const inFlight = new Set();
let appActive = true;

const saveJobs = () => Preferences.set({ key: 'jobs', value: JSON.stringify(jobs) });
async function loadJobs() {
  const j = await Preferences.get({ key: 'jobs' });
  try { if (j.value) jobs = JSON.parse(j.value); } catch {}
}

async function queueRecording(audio) {
  const id = `r${Date.now().toString(36)}`;
  const file = `${id}.${audio.mime === 'audio/mp3' ? 'mp3' : 'wav'}`;
  await Filesystem.writeFile({ path: file, data: audio.data, directory: Directory.Data });
  const job = { id, file, mime: audio.mime, seconds: audio.seconds, createdAt: new Date().toISOString(), status: 'pending', error: null };
  jobs.push(job);
  await saveJobs();
  render();
  processJob(job, audio.data);
}

async function processJob(job, data) {
  if (inFlight.has(job.id)) return;
  inFlight.add(job.id);
  job.status = 'pending'; job.error = null;
  render();
  try {
    if (!data) data = (await Filesystem.readFile({ path: job.file, directory: Directory.Data })).data;
    const result = await understand([{ text: prompt(true) }, { inline_data: { mime_type: job.mime, data } }]);
    const change = applyResult(result);
    jobs = jobs.filter((j) => j.id !== job.id);
    await saveJobs();
    await Filesystem.deleteFile({ path: job.file, directory: Directory.Data }).catch(() => {});
    await commit();
    const summary = change.created || change.updated ? changeSummary(change) : "Didn't catch anything to save";
    if (appActive) {
      if (change.created || change.updated) toast(summary, 'Undo', async () => { change.undo(); await commit(); });
      else toast(summary);
    } else {
      notifyNow('Recording sorted', summary);
    }
  } catch (e) {
    job.status = 'failed';
    job.error = friendlyError(e);
    await saveJobs();
    if (!appActive) notifyNow("Couldn't sort your recording", `${job.error} It's saved. Open Nudge to retry.`);
  } finally {
    inFlight.delete(job.id);
    render();
  }
}

function retryJobs() {
  for (const j of jobs) if (!inFlight.has(j.id)) processJob(j);
}

async function discardJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  jobs = jobs.filter((j) => j.id !== id);
  await saveJobs();
  await Filesystem.deleteFile({ path: job.file, directory: Directory.Data }).catch(() => {});
  render();
}

async function notifyNow(title, body) {
  if (!isNative) return;
  try {
    await LocalNotifications.schedule({ notifications: [{ id: 990 + Math.floor(Math.random() * 9), title, body, channelId: 'nudges', schedule: { at: new Date(Date.now() + 500), allowWhileIdle: true } }] });
  } catch (e) { console.error(e); }
}

const dur = (s) => `${Math.floor(s / 60)}:${pad(s % 60)}`;
function jobsHtml() {
  if (!jobs.length) return '';
  return `<section class="group">${jobs.map((j) => j.status === 'failed'
    ? `<article class="job failed" data-job="${j.id}">
        <div class="job-body"><p class="text">Couldn't sort a ${dur(j.seconds)} recording</p><p class="context">${esc(j.error || '')} It's saved on your phone.</p></div>
        <div class="job-actions"><button class="text-btn danger" data-job-act="discard">Discard</button><button class="primary" data-job-act="retry">Retry</button></div>
      </article>`
    : `<article class="job" data-job="${j.id}">
        <span class="spinner" aria-hidden="true"></span>
        <div class="job-body"><p class="text">Sorting a ${dur(j.seconds)} recording…</p><p class="context">Saved on your phone. You can leave the app; you'll get a notification when it's done.</p></div>
      </article>`).join('')}</section>`;
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
      const evs = calOn() ? eventsOn(ds) : [];
      settings.times.forEach((t, slot) => {
        const [hh, mm] = (t || '08:00').split(':').map(Number);
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
        const dayEvs = slot === 0 ? evs : [];
        if (at <= now || (!act.length && !dayEvs.length)) return;
        const lines = [];
        if (dayEvs.length) {
          lines.push(`Calendar: ${dayEvs.slice(0, 4).map((e) => `${evTime(e)} ${e.title}`).join(' · ')}${dayEvs.length > 4 ? ` +${dayEvs.length - 4}` : ''}`);
        }
        lines.push(...act.slice(0, 7).map((i) => `• ${i.text}`));
        if (act.length > 7) lines.push(`+ ${act.length - 7} more`);
        const body = act.length
          ? (act.length === 1 ? act[0].text : `${act[0].text} (+${act.length - 1} more)`)
          : `${dayEvs.length} on your calendar today: ${dayEvs[0].title}${dayEvs.length > 1 ? ' and more' : ''}`;
        list.push({
          id: 1000 + d * 10 + slot,
          title: SLOTS[slot].title,
          body,
          largeBody: lines.join('\n'),
          summaryText: act.length ? `${act.length} to remember` : 'Your day',
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

  if (!items.length && !jobs.length) {
    $('#list').innerHTML = calendarHtml() + `<div class="empty"><h2>Nothing to remember yet</h2><p>After a conversation, tap the mic and just talk. Nudge sorts it out and checks in with you morning, afternoon and night.</p><div class="empty-actions"><button class="secondary" data-act="restore">Restore from a backup file</button><button class="secondary" data-act="import-shots">Import from screenshots of your old list</button></div></div>`;
    return;
  }

  let html = jobsHtml() + calendarHtml();
  if (!items.length) { $('#list').innerHTML = html; return; }
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
  scheduleBackup();
  syncCalendar();
}

/* ---------------- Calendar ----------------
   Uses the phone's calendar (which syncs with Google Calendar), so there's no separate sign-in.
   - Items with a time go onto the calendar, and are updated or removed when they change.
   - Upcoming events are read in, shown on the home screen, added to morning check-ins,
     and given to Gemini so "after my 2pm call" makes sense. */
const NUDGE_MARK = '(Added by Nudge)';
let calEvents = []; // upcoming events from the calendar, excluding Nudge's own
let calSyncing = false;

const calNative = () => isNative || !!window.__nudgeCalTest; // test hook for the browser harness
const calOn = () => calNative() && settings.calendar?.enabled;

async function connectCalendar() {
  if (!calNative()) return toast('Only on the phone');
  try {
    const { result } = await CapacitorCalendar.requestFullCalendarAccess();
    if (result !== 'granted') {
      toast('Calendar permission was not given. You can allow it in Android Settings → Apps → Nudge.');
      return;
    }
    let cal = null;
    try { cal = (await CapacitorCalendar.getDefaultCalendar({ useFallbackCalendar: true })).result; } catch {}
    settings.calendar = { enabled: true, id: cal?.id || null, name: cal?.title || cal?.internalTitle || 'your calendar' };
    await saveSettings();
    renderCalendarStatus();
    await refreshCalendar();
    await syncCalendar();
    render(); await reschedule();
    toast(`Calendar connected: ${settings.calendar.name}`);
  } catch (e) {
    toast(`Couldn't connect the calendar: ${friendlyError(e)}`);
  }
}

async function disconnectCalendar() {
  settings.calendar = { enabled: false };
  calEvents = [];
  await saveSettings();
  renderCalendarStatus(); render(); await reschedule();
  toast('Calendar disconnected. Events already added stay on your calendar.');
}

function renderCalendarStatus() {
  const el = $('#cal-status');
  if (!el) return;
  const on = settings.calendar?.enabled;
  el.textContent = on
    ? `Connected to ${settings.calendar.name}. Anything with a set time goes on your calendar, and your events show in Nudge and in morning check-ins. Event titles and times are shared with Gemini when it sorts your notes.`
    : "Connect your phone's calendar (it syncs with Google Calendar). Timed items like interviews go on your calendar, and your events show up in Nudge.";
  $('#cal-connect').hidden = !!on;
  $('#cal-disconnect').hidden = !on;
}

async function refreshCalendar() {
  if (!calOn()) { calEvents = []; return; }
  try {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = addDays(from, DAYS_AHEAD + 1);
    const { result } = await CapacitorCalendar.listEventsInRange({ from: from.getTime(), to: to.getTime() });
    const mine = new Set(items.map((i) => i.calEventId).filter(Boolean));
    calEvents = (result || [])
      .filter((e) => !mine.has(String(e.id)) && !(e.description || '').includes(NUDGE_MARK))
      .map((e) => ({ id: String(e.id), title: e.title || '(No title)', start: e.startDate, end: e.endDate, allDay: !!e.isAllDay, location: e.location || null }))
      .sort((a, b) => a.start - b.start);
  } catch (e) {
    console.warn('calendar read failed', e);
  }
}

// Events on a given local day (all-day events are stored in UTC, so they're matched by UTC date).
function eventsOn(dateStr) {
  return calEvents.filter((e) => {
    if (e.allDay) return new Date(e.start).toISOString().slice(0, 10) === dateStr;
    const s = ymd(new Date(e.start)), en = ymd(new Date(Math.max(e.start, e.end - 1)));
    return s <= dateStr && dateStr <= en;
  });
}
const evTime = (e) => (e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));

function calendarContext() {
  if (!calOn() || !calEvents.length) return '';
  const lines = calEvents.slice(0, 40).map((e) => `- ${e.allDay ? new Date(e.start).toISOString().slice(0, 10) + ' (all day)' : localIso(new Date(e.start)).slice(0, 16).replace('T', ' ')}: ${e.title}`);
  return `\nHis calendar for the coming days (for context only; don't create items for these unless he asks):\n${lines.join('\n')}\n`;
}

function calendarHtml() {
  if (!calOn()) return '';
  const now = Date.now();
  const today = eventsOn(todayStr()).filter((e) => e.allDay || e.end > now);
  if (!today.length) return '';
  return `<section class="group cal"><div class="group-head"><h2>Today on your calendar</h2><span class="count">${today.length}</span></div>
    <div class="cal-list">${today.map((e) => `<div class="cal-row${!e.allDay && e.start <= now ? ' now' : ''}"><span class="cal-time">${evTime(e)}</span><span class="cal-title">${esc(e.title)}${e.location ? `<span class="cal-loc">${esc(e.location)}</span>` : ''}</span></div>`).join('')}</div></section>`;
}

// Puts timed items on the calendar and keeps them in step with Nudge.
async function syncCalendar() {
  if (!calOn() || calSyncing) return;
  calSyncing = true;
  let changed = false;
  try {
    const known = JSON.parse((await Preferences.get({ key: 'calLinks' })).value || '{}'); // itemId -> eventId
    const alive = new Set();
    for (const i of items) {
      const when = i.eventAt || i.remindAt;
      const want = !i.done && when && new Date(when).getTime() > Date.now() - 6 * 3600e3;
      if (!want) continue;
      alive.add(i.id);
      const start = new Date(when).getTime();
      const sig = `${i.text}|${start}|${i.context || ''}`;
      const opts = {
        title: i.text, startDate: start, endDate: start + 30 * 60e3,
        description: `${i.context ? i.context + '\n\n' : ''}${NUDGE_MARK}`,
        ...(settings.calendar.id ? { calendarId: settings.calendar.id } : {}),
      };
      try {
        if (i.calEventId && i.calSig === sig) continue;
        if (i.calEventId) {
          try { await CapacitorCalendar.modifyEvent({ id: i.calEventId, ...opts }); }
          catch { i.calEventId = null; }
        }
        if (!i.calEventId) {
          const { id } = await CapacitorCalendar.createEvent({ ...opts, commit: true });
          i.calEventId = id ? String(id) : null;
        }
        i.calSig = sig; known[i.id] = i.calEventId; changed = true;
      } catch (e) { console.warn('calendar write failed', e); }
    }
    // Remove events for items that were finished, deleted or lost their time.
    for (const [itemId, eventId] of Object.entries(known)) {
      if (alive.has(itemId) || !eventId) continue;
      try { await CapacitorCalendar.deleteEvent({ id: eventId }); } catch {}
      delete known[itemId];
      const it = items.find((x) => x.id === itemId);
      if (it) { it.calEventId = null; it.calSig = null; }
      changed = true;
    }
    await Preferences.set({ key: 'calLinks', value: JSON.stringify(known) });
    if (changed) await saveItems();
  } catch (e) {
    console.warn('calendar sync failed', e);
  } finally {
    calSyncing = false;
  }
}

/* ---------------- Backup that survives uninstalling ----------------
   After every change, the list is written to Documents/Nudge on the phone. That folder is
   outside the app, so Android keeps it if Nudge is uninstalled. A fresh install can restore
   from it through the file picker. The Gemini key is left out on purpose. */
const BACKUP_DIR = 'Nudge';
let backupTimer;
let backupState = { at: null, file: null, error: null };

function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(writeBackup, 1500);
}

async function writeBackup() {
  if (!items.length && !backupState.at) return; // nothing worth saving yet
  const payload = JSON.stringify({
    app: 'nudge', version: 1, exportedAt: new Date().toISOString(),
    items, settings: { times: settings.times, model: settings.model },
  }, null, 1);
  const saved = (await Preferences.get({ key: 'backupFile' })).value;
  const names = [saved || 'Nudge-backup.json', `Nudge-backup-${Date.now().toString(36)}.json`];
  for (const name of names) {
    try {
      await Filesystem.writeFile({ path: `${BACKUP_DIR}/${name}`, data: payload, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
      if (name !== saved) await Preferences.set({ key: 'backupFile', value: name });
      backupState = { at: new Date().toISOString(), file: name, error: null };
      await Preferences.set({ key: 'backupState', value: JSON.stringify(backupState) });
      renderBackupStatus();
      return;
    } catch (e) {
      // A file left by a previous install can't be overwritten; the second name avoids that.
      backupState.error = String(e?.message || e);
    }
  }
  renderBackupStatus();
}

async function loadBackupState() {
  try { const v = (await Preferences.get({ key: 'backupState' })).value; if (v) backupState = JSON.parse(v); } catch {}
}

function renderBackupStatus() {
  const el = $('#backup-status');
  if (!el) return;
  if (backupState.at) {
    const d = new Date(backupState.at);
    el.textContent = `Backed up automatically ${shortDay(backupState.at).toLowerCase() === 'today' ? 'today' : shortDay(backupState.at)} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} to Documents/Nudge/${backupState.file}. It stays on your phone even if you uninstall Nudge.`;
  } else if (backupState.error) {
    el.textContent = `Automatic backup isn't working on this phone (${backupState.error.slice(0, 80)}). Use "Save a copy now" instead.`;
  } else {
    el.textContent = 'Your list is backed up automatically to Documents/Nudge once you have something on it. It stays on your phone even if you uninstall Nudge.';
  }
}

async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("That file isn't a Nudge backup"); }
  if (data?.app !== 'nudge' || !Array.isArray(data.items)) return toast("That file isn't a Nudge backup");
  const byId = new Map(items.map((i) => [i.id, i]));
  let added = 0;
  for (const it of data.items) {
    if (!it?.id || !it.text) continue;
    const cur = byId.get(it.id);
    const stamp = (x) => x.updatedAt || x.doneAt || x.createdAt || '';
    if (!cur) { byId.set(it.id, it); added++; }
    else if (stamp(it) > stamp(cur)) byId.set(it.id, it);
  }
  items = [...byId.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (data.settings?.times?.length === 3 && !(await Preferences.get({ key: 'settings' })).value) settings.times = data.settings.times;
  await saveSettings();
  closeSheets();
  await commit();
  toast(added ? `Restored ${added} ${added === 1 ? 'item' : 'items'}` : 'Everything in that backup is already here');
}

/* ---------------- Import from screenshots ----------------
   Reads screenshots of a to-do / reminder list (e.g. an older copy of Nudge) and rebuilds the items. */
function importPrompt(count) {
  return `These ${count > 1 ? `${count} images are screenshots` : 'image is a screenshot'} of his previous reminder list (most likely an older copy of this same app, Nudge, possibly scrolled across several screenshots). Rebuild his list from ${count > 1 ? 'them' : 'it'}.
Today's date is ${todayStr()} (UTC${tzOffset()}).

How the Nudge screen is laid out: items sit in cards grouped under headings such as "On your mind today", "Tomorrow", or a date like "Tue, Oct 13", and a "Done" section at the bottom. Each card has the item text in bold, sometimes a grey detail line under it, sometimes a shaded box with a date and an update note, and coloured chips: "Follow up", "To do" or "Keep in mind", a person's name, and sometimes a time like "3:00 PM".

His current items (do not duplicate these):
${knownItems()}

Return one entry per card you can read:
- existing_id: the id of a matching current item if one exists, otherwise null.
- update: the text of the shaded update box if there is one, otherwise null.
- status: "done" if it is in the Done section or struck through, otherwise "open".
- text: the bold item text exactly as shown.
- kind: from the chip ("Follow up" -> "follow-up", "To do" -> "to-do", "Keep in mind" -> "keep in mind"); if no chip, choose the best fit.
- person: the person chip text, or null.
- context: the grey detail line, or null.
- start_date: YYYY-MM-DD from the heading it sits under ("On your mind today" -> today; "Tomorrow" -> tomorrow; a date heading -> that date in the current or next year). Default today.
- remind_at: if a time chip is shown, that time on the start date as ISO 8601 with offset ${tzOffset()}; otherwise null.
- event_at: if the card describes his own appointment at a stated time (e.g. "Interview at 4 PM"), that start time as ISO 8601 with offset; otherwise null.

If the same card appears in two overlapping screenshots, return it once. Skip anything that is not a list item (headers, buttons, banners, status bar). If the image is not a list at all, return an empty items list.
Also return "transcript": a plain-text list of what you read, one item per line.`;
}

// Shrinks a picked image so uploads stay small and fast.
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Couldn't read that image"));
    r.readAsDataURL(file);
  });
}
async function imageToJpeg(file, max = 1600) {
  const src = await withTimeout(readAsDataUrl(file), 20000, "Couldn't read that image");
  const img = await withTimeout(new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Couldn't open that image"));
    im.src = src;
  }), 20000, "Couldn't open that image");
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

let importCancelled = false;
let cancelImport = () => {};

async function importScreenshots(files) {
  files = files.slice(0, 10);
  if (!files.length) return;
  if (!settings.key.trim()) { openSettings(); toast('Add your Gemini key first, then import'); return; }
  closeSheets();
  importCancelled = false;
  // Cancel stops waiting immediately, even mid-request.
  const cancelled = new Promise((_, rej) => { cancelImport = () => { importCancelled = true; rej(Object.assign(new Error('cancelled'), { cancelled: true })); }; });
  cancelled.catch(() => {});
  const ov = $('#rec');
  ov.hidden = false; ov.classList.remove('paused'); ov.classList.add('busy', 'importing');
  const started = Date.now();
  let step = '';
  const show = (title, hint) => { step = title; $('#rec-time').textContent = title; if (hint) $('#rec-hint').textContent = hint; };
  $('#rec-state').textContent = 'Importing screenshots';
  const clock = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('#rec-state').textContent = `Importing screenshots · ${Math.floor(s / 60)}:${pad(s % 60)}`;
  }, 500);

  const totals = { created: 0, updated: 0 };
  const undos = [];
  const failed = [];
  try {
    for (let n = 0; n < files.length; n++) {
      if (importCancelled) break;
      const label = files.length > 1 ? `${n + 1} of ${files.length}` : '1 screenshot';
      show(label, 'Preparing the image…');
      try {
        const data = await Promise.race([imageToJpeg(files[n]), cancelled]);
        if (importCancelled) break;
        show(label, 'Gemini is reading it. Usually 10–30 seconds.');
        // Items found in earlier screenshots are part of the prompt, so overlaps aren't duplicated.
        const result = await Promise.race([understand([{ text: importPrompt(1) }, { inline_data: { mime_type: 'image/jpeg', data } }], 90000), cancelled]);
        if (importCancelled) break;
        const change = applyResult(result);
        totals.created += change.created; totals.updated += change.updated;
        undos.push(change.undo);
        await saveItems();
      } catch (e) {
        if (e?.cancelled) break;
        failed.push({ n: n + 1, msg: friendlyError(e) });
      }
    }
  } finally {
    clearInterval(clock);
    ov.hidden = true;
    ov.classList.remove('importing');
  }
  await commit();
  const undoAll = async () => { for (const u of undos.reverse()) u(); await commit(); };
  const got = totals.created || totals.updated;
  if (importCancelled) toast(got ? `Stopped · kept ${changeSummary(totals)}` : 'Import cancelled', got ? 'Undo' : null, undoAll);
  else if (failed.length && !got) toast(`Import failed: ${failed[0].msg}`);
  else if (failed.length) toast(`Imported · ${changeSummary(totals)} · screenshot ${failed.map((f) => f.n).join(', ')} failed`, 'Undo', undoAll);
  else if (got) toast(`Imported · ${changeSummary(totals)}`, 'Undo', undoAll);
  else toast("Couldn't find any list items in those screenshots");
}

async function saveCopyNow() {
  // Hands a copy to Android's own "save file" flow, so it can go to Downloads, Drive, WhatsApp, etc.
  const blob = new Blob([JSON.stringify({ app: 'nudge', version: 1, exportedAt: new Date().toISOString(), items, settings: { times: settings.times, model: settings.model } }, null, 1)], { type: 'application/json' });
  const name = `Nudge-backup-${todayStr()}.json`;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Nudge backup' }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  await writeBackup();
  toast(backupState.at ? 'Saved to Documents/Nudge' : "Couldn't save a copy");
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

function showRecording() {
  const ov = $('#rec');
  ov.hidden = false;
  ov.classList.remove('busy', 'paused');
  $('#rec-state').textContent = 'Listening';
  $('#rec-hint').textContent = 'Talk it through. Who, what, and when if it matters.';
  clearInterval(timerInt);
  const tick = () => {
    const ms = sessionMs();
    const s = Math.floor(ms / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    if (ms >= MAX_MS) finishCapture();
  };
  tick(); timerInt = setInterval(tick, 250);
}

function showPaused(reason) {
  clearInterval(timerInt);
  const ov = $('#rec');
  ov.hidden = false;
  ov.classList.remove('busy');
  ov.classList.add('paused');
  const s = Math.floor(sessionMs() / 1000);
  $('#rec-time').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
  $('#rec-state').textContent = 'Paused';
  $('#rec-hint').textContent = reason || "Recording paused when you left the app. Nothing has been sent. Carry on where you stopped, or finish now.";
}

async function beginCapture() {
  if (!settings.key.trim()) { openSettings(); toast('Add your Gemini key first'); return; }
  if (session) { if (!session.live) showPaused(); return; }
  try {
    await startMic();
  } catch (e) {
    session = null;
    toast('Microphone permission is needed to record');
    return;
  }
  showRecording();
}

async function resumeCapture() {
  try {
    await startMic();
  } catch (e) {
    toast('Microphone is not available right now');
    return;
  }
  await clearDraft();
  showRecording();
}

// Called when the app is sent to the background mid-recording (screen off, call, app switch).
async function pauseCapture() {
  if (!session?.live) return;
  await stopMic();
  showPaused();
  await saveDraft();
  notifyNow('Recording paused', `Your ${dur(Math.floor(sessionMs() / 1000))} recording is safe. Open Nudge to carry on or finish.`);
}

async function finishCapture() {
  if (!session) return;
  clearInterval(timerInt);
  const ov = $('#rec');
  ov.classList.add('busy');
  ov.classList.remove('paused');
  $('#rec-state').textContent = 'Saving';
  $('#rec-hint').textContent = 'One moment…';
  let audio = null;
  try { audio = await stopRecording(); } catch (e) { console.error(e); }
  ov.hidden = true;
  if (!audio) { toast('That was too short. Hold on a little longer.'); return; }
  try {
    await queueRecording(audio);
  } catch (e) {
    toast(`Couldn't save the recording: ${friendlyError(e)}`);
  }
}

async function cancelCapture() {
  clearInterval(timerInt);
  const hadAudio = sessionMs() > 3000;
  await stopMic();
  session = null;
  await clearDraft();
  $('#rec').hidden = true;
  if (hadAudio) toast('Recording discarded');
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
  renderBackupStatus();
  renderCalendarStatus();
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
  $('#rec-resume').onclick = resumeCapture;
  $('#rec-busy-cancel').onclick = () => cancelImport();
  $('#rec-finish').onclick = finishCapture;
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
    if (e.target.closest('[data-act="restore"]')) { $('#restore-input').click(); return; }
    if (e.target.closest('[data-act="import-shots"]')) { $('#shots-input').click(); return; }
    const jb = e.target.closest('[data-job-act]');
    if (jb) {
      const id = jb.closest('[data-job]').dataset.job;
      if (jb.dataset.jobAct === 'retry') { const j = jobs.find((x) => x.id === id); if (j) processJob(j); }
      else discardJob(id);
      return;
    }
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
    closeSheets(); render(); await reschedule(); scheduleBackup();
    toast('Saved');
  };
  $('#cal-connect').onclick = connectCalendar;
  $('#cal-disconnect').onclick = disconnectCalendar;
  $('#set-restore').onclick = () => $('#restore-input').click();
  $('#set-shots').onclick = () => $('#shots-input').click();
  $('#shots-input').onchange = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    await importScreenshots(files);
  };
  $('#set-backup').onclick = saveCopyNow;
  $('#restore-input').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) await restoreFromFile(f);
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

  App.addListener('appStateChange', ({ isActive }) => {
    appActive = isActive;
    if (!isActive && session?.live) pauseCapture(); // screen off / call / app switch: pause, never send half a note
    if (isActive) { refreshCalendar().then(() => { render(); reschedule(); syncCalendar(); }); retryJobs(); }
  });
}

(async function init() {
  await load();
  await loadJobs();
  await loadBackupState();
  bind();
  render();
  if (await loadDraft()) showPaused('You have an unfinished recording from earlier. Nothing has been sent. Carry on where you stopped, or finish now.');
  retryJobs();
  await setupNotifications();
  await refreshCalendar();
  render();
  await reschedule();
  scheduleBackup();
  syncCalendar();
})();
