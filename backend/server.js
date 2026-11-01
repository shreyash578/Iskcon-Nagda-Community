/**
 * ISKCON NAGDA COMMUNITY — Backend v3.0
 * Real-time push via SSE, Admin Panel, Full notification control
 */
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const webPush    = require('web-push');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const { XMLParser } = require('fast-xml-parser');

const app  = express();
const PORT = process.env.PORT || 3000;
const emailTransport = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;
const EMAIL_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'ISKCON Nagda Community <no-reply@iskcon.local>';
const YOUTUBE_CHANNEL_ID = (process.env.YOUTUBE_CHANNEL_ID || '').trim();
const YOUTUBE_CHANNEL_URL = process.env.YOUTUBE_CHANNEL_URL || 'https://www.youtube.com/results?search_query=ISKCON+Nagda';
const YOUTUBE_LIVE_URL = process.env.YOUTUBE_LIVE_URL || (process.env.YOUTUBE_CHANNEL_URL ? `${YOUTUBE_CHANNEL_URL}/live` : YOUTUBE_CHANNEL_URL);
const YOUTUBE_STATE_FILE = path.join(__dirname, 'youtube_feed_state.json');
const youtubeParser = new XMLParser({ ignoreAttributes: false });
let youtubeLatest = [];
let youtubeLastSeen = '';

function sendUserEmail({ to, subject, text }) {
  if (!emailTransport) {
    console.warn('[email] SMTP is not configured; skipped email to ' + to);
    return Promise.resolve({ sent: false, reason: 'SMTP is not configured' });
  }
  return emailTransport.sendMail({ from: EMAIL_FROM, to, subject, text })
    .then(info => ({ sent: true, messageId: info.messageId }))
    .catch(error => {
      console.error('[email] Failed to send email:', error.message);
      return { sent: false, reason: error.message };
  });
}

const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WHATSAPP_ACCESS_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();

function normalizeWhatsAppNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `91${digits}` : digits;
}

async function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    return { sent: false, reason: 'WhatsApp Cloud API is not configured' };
  }
  const recipient = normalizeWhatsAppNumber(to);
  if (!recipient) return { sent: false, reason: 'Invalid phone number' };

  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { preview_url: false, body: text }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp API failed: ${response.status} ${await response.text()}`);
  return { sent: true };
}

function registeredContacts() {
  const contacts = new Map();
  const add = entry => {
    const email = String(entry.email || '').trim().toLowerCase();
    const phone = normalizeWhatsAppNumber(entry.phone);
    const key = email || phone;
    if (!key) return;
    const current = contacts.get(key) || { email, phone, name: entry.name || '' };
    if (!current.email) current.email = email;
    if (!current.phone) current.phone = phone;
    if (!current.name) current.name = entry.name || '';
    contacts.set(key, current);
  };
  (db.events || []).forEach(event => (event.registrations || []).forEach(add));
  (db.trips || []).forEach(trip => (trip.bookings || []).forEach(add));
  (db.meetings || []).forEach(meeting => (meeting.rsvps || []).forEach(add));
  (db.donations || []).forEach(add);
  (db.volunteers || []).forEach(add);
  (db.newsletter || []).forEach(add);
  return [...contacts.values()];
}

async function notifyRegisteredContacts(title, body) {
  const contacts = registeredContacts();
  const text = `${title}\n\n${body}\n\nISKCON Nagda Community\nHare Krishna 🙏`;
  const emailJobs = contacts.filter(contact => contact.email).map(contact => sendUserEmail({ to: contact.email, subject: title, text }));
  const whatsappJobs = contacts.filter(contact => contact.phone).map(contact => sendWhatsAppMessage(contact.phone, text).catch(error => ({ sent: false, reason: error.message })));
  const [emails, whatsapp] = await Promise.all([Promise.all(emailJobs), Promise.all(whatsappJobs)]);
  return {
    contacts: contacts.length,
    emailsSent: emails.filter(result => result && result.sent).length,
    whatsappSent: whatsapp.filter(result => result && result.sent).length
  };
}

function sendUserNotification({ email, phone, subject, text }) {
  sendUserEmail({ to: email, subject, text });
  if (phone) sendWhatsAppMessage(phone, text).catch(error => console.error('[whatsapp] Delivery failed:', error.message));
}

function loadYouTubeState() {
  try {
    const state = JSON.parse(fs.readFileSync(YOUTUBE_STATE_FILE, 'utf8'));
    youtubeLastSeen = state.lastSeen || '';
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[youtube] Failed to load feed state:', error.message);
  }
}

function saveYouTubeState() {
  try {
    fs.writeFileSync(YOUTUBE_STATE_FILE, JSON.stringify({ lastSeen: youtubeLastSeen }, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('[youtube] Failed to save feed state:', error.message);
  }
}

async function syncYouTubeFeed({ notify = true } = {}) {
  if (!YOUTUBE_CHANNEL_ID) return { configured: false, latest: youtubeLatest };
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(YOUTUBE_CHANNEL_ID)}`);
  if (!response.ok) throw new Error(`YouTube RSS failed: ${response.status}`);
  const parsed = youtubeParser.parse(await response.text());
  const entries = parsed.feed && parsed.feed.entry ? (Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry]) : [];
  const latest = entries.slice(0, 12).map(entry => ({
    id: String(entry['yt:videoId'] || ''),
    title: String(entry.title || 'ISKCON Nagda devotional video'),
    publishedAt: String(entry.published || ''),
    updatedAt: String(entry.updated || ''),
    url: `https://www.youtube.com/watch?v=${entry['yt:videoId'] || ''}`,
    thumbnail: `https://i.ytimg.com/vi/${entry['yt:videoId'] || ''}/hqdefault.jpg`,
    author: entry.author && entry.author.name ? String(entry.author.name) : 'ISKCON Nagda'
  })).filter(video => video.id);
  youtubeLatest = latest;
  const newest = latest[0];
  if (notify && newest && youtubeLastSeen && newest.id !== youtubeLastSeen) {
    pushNotif('youtube', 'New ISKCON Nagda video', newest.title, '📺', 'system');
    sendWebPushToAll({ title: 'New ISKCON Nagda video', body: newest.title, iconUrl: '/iskcon-logo.png', url: newest.url, vibrate: [300, 120, 300] }).catch(error => console.error('[youtube] Push failed:', error.message));
    notifyRegisteredContacts('New ISKCON Nagda video', `${newest.title}\nWatch: ${newest.url}`).catch(error => console.error('[youtube] Contact notification failed:', error.message));
  }
  if (newest) {
    youtubeLastSeen = newest.id;
    saveYouTubeState();
  }
  return { configured: true, latest: youtubeLatest };
}

loadYouTubeState();

if (!emailTransport) {
  console.warn('[email] Receipt emails are disabled. Copy backend/.env.example to backend/.env and configure SMTP.');
}
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../admin/index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

/* ─── DATABASE ─── */
const db = {
  events: [],
  trips: [],
  lectures: [],
  meetings: [],
  notices: [],
  notifications: [],
  donations: [],
  volunteers: [],
  newsletter: [],
  liveStream: { isLive:false, embedId:'', channelUrl:YOUTUBE_CHANNEL_URL, liveUrl:YOUTUBE_LIVE_URL, currentProgram:'', viewerCount:0, updatedAt:'' },
  darshan: [],
  vaisnavaCalendar: [],
  parampara: [
    { id:'pp1', name:'Sri Chaitanya Mahaprabhu', role:'Gaudiya Vaishnavism', period:'1486–1534', order:1, notes:'' },
    { id:'pp2', name:'A.C. Bhaktivedanta Swami Prabhupada', role:'Founder-Acharya of ISKCON', period:'1896–1977', order:2, notes:'' }
  ],
  liveLectures: [],
  stats: { totalDonations:0, totalDonors:0, totalRegistrations:0, totalVolunteers:0 },
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sseClients: [],
  pushSubs: []
};

const MAYAPUR_2026_2027_CALENDAR = 'https://srimayapurdhama.com/festivals/2026-2027/';
const VERIFIED_2026_CALENDAR = [
  { id:'rama-ekadashi-2026', date:'2026-11-05', title:'Rama Ekadashi', type:'ekadashi', fasting:'Follow your local temple’s Ekadashi guidance.', notes:'ISKCON Mayapur calendar observance.', source:'ISKCON Mayapur Festival Calendar 2026–2027', sourceUrl:MAYAPUR_2026_2027_CALENDAR },
  { id:'dipavali-2026', date:'2026-11-09', title:'Dipavali', type:'festival', notes:'Festival of lamps. Local program details are announced by the temple.', source:'ISKCON Mayapur Festival Calendar 2026–2027', sourceUrl:MAYAPUR_2026_2027_CALENDAR },
  { id:'govardhana-puja-2026', date:'2026-11-10', title:'Govardhana Puja', type:'festival', notes:'Govardhana Puja and Annakuta. Local program details are announced by the temple.', source:'ISKCON Mayapur Festival Calendar 2026–2027', sourceUrl:MAYAPUR_2026_2027_CALENDAR },
  { id:'utthana-ekadashi-2026', date:'2026-11-21', title:'Utthana Ekadashi', type:'ekadashi', fasting:'Follow your local temple’s Ekadashi guidance.', notes:'ISKCON Mayapur calendar observance.', source:'ISKCON Mayapur Festival Calendar 2026–2027', sourceUrl:MAYAPUR_2026_2027_CALENDAR },
  { id:'utpanna-ekadashi-2026', date:'2026-12-05', title:'Utpanna Ekadashi', type:'ekadashi', fasting:'Follow your local temple’s Ekadashi guidance.', notes:'ISKCON Mayapur calendar observance.', source:'ISKCON Mayapur Festival Calendar 2026–2027', sourceUrl:MAYAPUR_2026_2027_CALENDAR },
  { id:'gita-jayanti-2026', date:'2026-12-20', title:'Gita Jayanti', type:'festival', notes:'Commemoration of the speaking of Bhagavad-gita. Local program details are announced by the temple.', source:'ISKCON Mayapur Festival Calendar 2026–2027', sourceUrl:MAYAPUR_2026_2027_CALENDAR }
];
db.vaisnavaCalendar = VERIFIED_2026_CALENDAR;

const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CALENDAR_STORE_FILE = path.join(__dirname, 'vaisnava_calendar_overrides.json');
const PUSH_STORE_FILE = path.join(__dirname, 'push_subscriptions.json');
const ADMIN_CREDENTIALS_FILE = path.join(__dirname, 'admin-credentials.json');
let storedAdminCredential = null;
try {
  storedAdminCredential = JSON.parse(fs.readFileSync(ADMIN_CREDENTIALS_FILE, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') console.error('[admin] Failed to load saved credentials:', error.message);
}

function makeAdminCredential(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function matchesAdminPassword(password) {
  if (storedAdminCredential && storedAdminCredential.salt && storedAdminCredential.hash) {
    const expected = Buffer.from(storedAdminCredential.hash, 'hex');
    const actual = crypto.scryptSync(password, storedAdminCredential.salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  }
  return Boolean(db.adminPassword) && password === db.adminPassword;
}

function persistAdminCredential(credential) {
  const tempFile = `${ADMIN_CREDENTIALS_FILE}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(credential, null, 2)}\n`, { encoding:'utf8', mode:0o600 });
  fs.renameSync(tempFile, ADMIN_CREDENTIALS_FILE);
}

function persistCalendarStore() {
  try {
    fs.writeFileSync(CALENDAR_STORE_FILE, JSON.stringify({ calendar: db.vaisnavaCalendar || [] }, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('[calendar] Failed to persist calendar:', error.message);
  }
}

function loadCalendarStore() {
  try {
    const stored = JSON.parse(fs.readFileSync(CALENDAR_STORE_FILE, 'utf8'));
    if (Array.isArray(stored.calendar) && stored.calendar.length) db.vaisnavaCalendar = stored.calendar;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[calendar] Failed to load stored calendar:', error.message);
  }
  persistCalendarStore();
}

loadCalendarStore();

function persistPushSubscriptions() {
  try {
    fs.writeFileSync(PUSH_STORE_FILE, JSON.stringify({ subscriptions: db.pushSubs || [] }, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('[push] Failed to persist subscriptions:', error.message);
  }
}

function loadPushSubscriptions() {
  try {
    const stored = JSON.parse(fs.readFileSync(PUSH_STORE_FILE, 'utf8'));
    if (Array.isArray(stored.subscriptions)) db.pushSubs = stored.subscriptions.filter(entry => isValidSubscription(entry && entry.subscription));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[push] Failed to load subscriptions:', error.message);
  }
}

loadPushSubscriptions();

const SITE_DATA_FILE = path.resolve(process.env.SITE_DATA_FILE || path.join(__dirname, 'site-data.json'));
const PERSISTED_DB_KEYS = [
  'events', 'trips', 'lectures', 'meetings', 'notices', 'notifications', 'donations',
  'volunteers', 'newsletter', 'liveStream', 'darshan', 'vaisnavaCalendar', 'parampara',
  'liveLectures', 'stats'
];

function loadSiteData() {
  try {
    const stored = JSON.parse(fs.readFileSync(SITE_DATA_FILE, 'utf8'));
    PERSISTED_DB_KEYS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(stored, key)) db[key] = stored[key];
    });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[data] Failed to load site data:', error.message);
  }
}

function persistSiteData() {
  const snapshot = Object.fromEntries(PERSISTED_DB_KEYS.map(key => [key, db[key]]));
  const tempFile = `${SITE_DATA_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(SITE_DATA_FILE), { recursive: true });
    fs.writeFileSync(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tempFile, SITE_DATA_FILE);
  } catch (error) {
    console.error('[data] Failed to persist site data:', error.message);
    try { fs.unlinkSync(tempFile); } catch (cleanupError) {}
  }
}

loadSiteData();
let removedDemoRecords = false;
function removeDemoRecords(key, ids) {
  const remaining = (db[key] || []).filter(item => !ids.has(String(item.id)));
  if (remaining.length !== (db[key] || []).length) {
    db[key] = remaining;
    removedDemoRecords = true;
  }
}
removeDemoRecords('events', new Set(['ev1', 'ev2', 'ev3', 'ev4', 'ev5']));
removeDemoRecords('trips', new Set(['tr1', 'tr2', 'tr3']));
removeDemoRecords('lectures', new Set(['lc1', 'lc2', 'lc3', 'lc4', 'lc5', 'lc6']));
removeDemoRecords('meetings', new Set(['mt1', 'mt2', 'mt3', 'mt4']));
removeDemoRecords('notices', new Set(['nt1', 'nt2', 'nt3', 'nt4', 'nt5', 'nt6']));
removeDemoRecords('parampara', new Set(['pp3']));
const oldCalendarIds = /^(?:vc-2026-|observance-2026-kartik-damodara)/;
const verifiedCalendarIds = new Set(VERIFIED_2026_CALENDAR.map(item => item.id));
const savedCalendarItems = db.vaisnavaCalendar || [];
const calendarNeedsRefresh = savedCalendarItems.some(item => oldCalendarIds.test(String(item.id || ''))) ||
  VERIFIED_2026_CALENDAR.some(verified => {
    const saved = savedCalendarItems.find(item => String(item.id) === verified.id);
    return !saved || saved.date !== verified.date || saved.title !== verified.title || saved.sourceUrl !== verified.sourceUrl;
  });
const retainedCalendarItems = savedCalendarItems.filter(item =>
  !oldCalendarIds.test(String(item.id || '')) && !verifiedCalendarIds.has(String(item.id || ''))
);
if (calendarNeedsRefresh || retainedCalendarItems.length !== savedCalendarItems.length) removedDemoRecords = true;
db.vaisnavaCalendar = [...VERIFIED_2026_CALENDAR, ...retainedCalendarItems];
const sampleDarshanNames = new Set(['Mangala Aarti', 'Darshan Opens', 'Raj Bhog Aarti', 'Afternoon Darshan', 'Gaura Aarti', 'Shayan Aarti']);
const realDarshanItems = (db.darshan || []).filter(item => !sampleDarshanNames.has(item.name));
if (realDarshanItems.length !== (db.darshan || []).length) {
  db.darshan = realDarshanItems;
  removedDemoRecords = true;
}
if (db.liveStream && !db.liveStream.isLive && !db.liveStream.embedId && db.liveStream.currentProgram === 'ISKCON Nagda Aarti & Darshan') {
  db.liveStream.currentProgram = '';
  db.liveStream.updatedAt = '';
  removedDemoRecords = true;
}
if (removedDemoRecords) persistSiteData();
app.use((req, res, next) => {
  const transientWrite = ['/api/chat', '/api/push/subscribe', '/api/admin/push'].includes(req.path);
  if (!transientWrite && req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400) persistSiteData();
    });
  }
  next();
});

/* ─── HELPERS ─── */
const ok  = (res, data, msg='Success') => res.json({ success:true, message:msg, data });
const err = (res, msg, code=400)       => res.status(code).json({ success:false, message:msg });

function createAdminSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    email,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });
  return { token, expiresInSeconds: Math.floor(ADMIN_SESSION_TTL_MS / 1000) };
}

function isValidAdminSession(token) {
  if (!token) return false;
  const session = adminSessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function loadOrCreateVapidKeys() {
  const publicKeyFromEnv = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKeyFromEnv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (publicKeyFromEnv && privateKeyFromEnv) return { publicKey: publicKeyFromEnv, privateKey: privateKeyFromEnv };

  const filePath = path.join(__dirname, '.vapid.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.publicKey && parsed.privateKey) return parsed;
  } catch (e) {}

  const keys = webPush.generateVAPIDKeys();
  try { fs.writeFileSync(filePath, JSON.stringify(keys, null, 2), 'utf8'); } catch (e) {}
  return keys;
}

const vapid = loadOrCreateVapidKeys();
webPush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@iskcon.local', vapid.publicKey, vapid.privateKey);

function isValidSubscription(sub) {
  return !!(sub && typeof sub === 'object' && sub.endpoint && sub.keys && sub.keys.p256dh && sub.keys.auth);
}

async function sendWebPushToAll(payloadObj) {
  const payload = JSON.stringify(payloadObj || {});
  const subs = db.pushSubs || [];
  const kept = [];
  let delivered = 0;
  for (const entry of subs) {
    const sub = entry && entry.subscription ? entry.subscription : entry;
    if (!isValidSubscription(sub)) continue;
    try {
      await webPush.sendNotification(sub, payload);
      kept.push(entry);
      delivered++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code && (code === 404 || code === 410)) {
        // expired subscription, drop it
      } else {
        kept.push(entry);
      }
    }
  }
  db.pushSubs = kept;
  persistPushSubscriptions();
  return { delivered, total: subs.length, active: kept.length };
}

function pushNotif(type, title, body, icon, sentBy) {
  const n = { id:uuidv4(), type, title, body, icon:icon||'🔔', sentBy:sentBy||'system', createdAt:new Date().toISOString(), read:false };
  db.notifications.unshift(n);
  if (db.notifications.length > 100) db.notifications.pop();
  if (n.sentBy === 'admin') {
    const payload = 'data: ' + JSON.stringify(n) + '\n\n';
    db.sseClients = db.sseClients.filter(c => { try { c.write(payload); return true; } catch(e) { return false; } });
  }
  console.log('Push sent [' + type + '] ' + title + ' to ' + db.sseClients.length + ' clients');
  return n;
}

function broadcastUpdate(section) {
  const payload = 'data: ' + JSON.stringify({ type: 'update', section }) + '\n\n';
  db.sseClients = db.sseClients.filter(c => { try { c.write(payload); return true; } catch(e) { return false; } });
  console.log('Update broadcast: ' + section + ' to ' + db.sseClients.length + ' clients');
}

function adminAuth(req, res, next) {
  if (!storedAdminCredential && !db.adminPassword) return err(res, 'Admin sign-in is unavailable. Please contact the temple administrator.', 503);
  const token = req.headers['x-admin-token'] || req.query.token;
  if (isValidAdminSession(token)) return next();

  const pass = req.headers['x-admin-password'] || (req.body && req.body.adminPassword) || req.query.password;
  if (typeof pass !== 'string' || !matchesAdminPassword(pass)) return err(res, 'Unauthorized. Wrong admin password.', 401);
  next();
}

app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) return err(res, 'New password must be at least 8 characters.');
  if (typeof currentPassword !== 'string' || !matchesAdminPassword(currentPassword)) return err(res, 'Current password is incorrect.', 401);
  try {
    const credential = makeAdminCredential(newPassword);
    persistAdminCredential(credential);
    storedAdminCredential = credential;
    db.adminPassword = '';
    ok(res, null, 'Admin password changed. Use the new password next time you log in.');
  } catch (error) {
    console.error('[admin] Failed to save new password:', error.message);
    err(res, 'Could not save the new password. Check that the backend can write to its data folder.', 500);
  }
});

function toSlug(s) {
  return (s || '').toString().toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 60);
}

function buildEventPoster(event) {
  const calendarItem = (db.vaisnavaCalendar || []).find(item => item.date === event.date);
  const isFestival = event.category === 'festival' || event.category === 'yatra' || !!calendarItem;
  const title = calendarItem ? calendarItem.title : event.title;
  const blessing = calendarItem && calendarItem.compliment
    ? calendarItem.compliment
    : 'Hare Krishna! Join the devotees in joyful service, kirtan and remembrance of Sri Hari.';
  const description = event.description || (calendarItem
    ? `${calendarItem.title} at ISKCON Nagda. ${calendarItem.notes || 'Join kirtan, hear Krishna-katha and serve with the devotees.'}`
    : 'Join ISKCON Nagda for kirtan, seva, prasadam and devotional association.');
  const palette = calendarItem && calendarItem.type === 'ekadashi'
    ? { background: '#164A41', accent: '#E6BF5A' }
    : { background: '#7B1E2E', accent: '#F8D477' };

  return {
    isFestival,
    calendarId: calendarItem ? calendarItem.id : null,
    calendarTitle: calendarItem ? calendarItem.title : null,
    posterTitle: title,
    posterSubtitle: calendarItem ? 'ISKCON Mayapur published calendar' : 'ISKCON Nagda Community Seva',
    posterBlessing: blessing,
    posterDescription: description,
    posterBackground: palette.background,
    posterAccent: palette.accent,
    generatedAt: new Date().toISOString()
  };
}

/* ─── SSE STREAM ─── */
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('data: ' + JSON.stringify({ type:'connected', message:'Connected to ISKCON live stream', recent:db.notifications.filter(n => n.sentBy === 'admin').slice(0,5) }) + '\n\n');
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) { clearInterval(ping); } }, 25000);
  db.sseClients.push(res);
  console.log('SSE client connected. Total: ' + db.sseClients.length);
  req.on('close', () => {
    clearInterval(ping);
    db.sseClients = db.sseClients.filter(c => c !== res);
    console.log('SSE client disconnected. Total: ' + db.sseClients.length);
  });
});

/* ─── ADMIN ROUTES ─── */
app.post('/api/admin/notify', adminAuth, async (req, res) => {
  const { title, body, type, icon, push } = req.body;
  if (!title || !body) return err(res, 'Title and body required');
  const n = pushNotif(type||'announcement', title, body, icon||'📢', 'admin');
  const pushStats = push === true
    ? await sendWebPushToAll({ title, body, iconUrl: '/iskcon-logo.png', url: '/', vibrate: [300, 120, 300], sound: '/iskcon-bell.mp3' })
    : { delivered: 0, total: 0, active: (db.pushSubs || []).length };
  const registeredCount = registeredContacts().length;
  notifyRegisteredContacts(title, body).then(stats => console.log('[notify] Registered contact delivery:', stats)).catch(error => console.error('[notify] Registered contact delivery failed:', error.message));
  ok(res, { notification:n, clientsReached:db.sseClients.length, pushStats, registeredContacts:registeredCount }, 'Announcement sent to the website and delivery queued for ' + registeredCount + ' registered contact(s).');
});

app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  const { message, type, push } = req.body;
  if (!message) return err(res, 'Message required');
  const t = type || 'announcement';
  const n = pushNotif(t, t==='urgent' ? '🚨 Urgent Notice' : '📢 Temple Announcement', message, t==='urgent'?'🚨':'📢', 'admin');
  const pushStats = push === true
    ? await sendWebPushToAll({ title: n.title, body: message, iconUrl: '/iskcon-logo.png', url: '/', vibrate: [300, 120, 300], sound: '/iskcon-bell.mp3' })
    : { delivered: 0, total: 0, active: (db.pushSubs || []).length };
  const registeredCount = registeredContacts().length;
  notifyRegisteredContacts(n.title, message).then(stats => console.log('[notify] Registered contact delivery:', stats)).catch(error => console.error('[notify] Registered contact delivery failed:', error.message));
  ok(res, { delivered:db.sseClients.length, notification:n, pushStats, registeredContacts:registeredCount }, 'Announcement sent to the website and delivery queued for ' + registeredCount + ' registered contact(s).');
});

app.post('/api/admin/push', adminAuth, async (req, res) => {
  const { title, body, iconUrl, url } = req.body || {};
  if (!title || !body) return err(res, 'Title and body required');
  const stats = await sendWebPushToAll({ title, body, iconUrl: iconUrl || '/iskcon-logo.png', url: url || '/' });
  ok(res, stats, `Push sent to ${stats.delivered} device(s)`);
});

app.get('/api/admin/calendar', adminAuth, (req, res) => ok(res, db.vaisnavaCalendar || []));
app.post('/api/admin/calendar', adminAuth, (req, res) => {
  const { date, title, type, fasting, notes } = req.body || {};
  if (!date || !title) return err(res, 'date and title required');
  const item = { id: uuidv4(), date, title, type: type || 'festival', fasting: fasting || '', notes: notes || '', createdAt: new Date().toISOString() };
  db.vaisnavaCalendar.unshift(item);
  persistCalendarStore();
  broadcastUpdate('calendar');
  ok(res, item, 'Calendar item added');
});
app.put('/api/admin/calendar/:id', adminAuth, (req, res) => {
  const i = (db.vaisnavaCalendar || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return err(res, 'Not found', 404);
  db.vaisnavaCalendar[i] = { ...db.vaisnavaCalendar[i], ...req.body };
  persistCalendarStore();
  broadcastUpdate('calendar');
  ok(res, db.vaisnavaCalendar[i], 'Calendar item updated');
});
app.delete('/api/admin/calendar/:id', adminAuth, (req, res) => {
  const i = (db.vaisnavaCalendar || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return err(res, 'Not found', 404);
  const deleted = db.vaisnavaCalendar.splice(i, 1)[0];
  persistCalendarStore();
  broadcastUpdate('calendar');
  ok(res, deleted, 'Calendar item deleted');
});

app.get('/api/admin/parampara', adminAuth, (req, res) => ok(res, db.parampara || []));
app.post('/api/admin/parampara', adminAuth, (req, res) => {
  const { name, role, period, order, notes } = req.body || {};
  if (!name) return err(res, 'name required');
  const item = { id: uuidv4(), name, role: role || '', period: period || '', order: Number.isFinite(order) ? order : ((db.parampara || []).length + 1), notes: notes || '' };
  db.parampara.push(item);
  ok(res, item, 'Parampara entry added');
});
app.put('/api/admin/parampara/:id', adminAuth, (req, res) => {
  const i = (db.parampara || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return err(res, 'Not found', 404);
  db.parampara[i] = { ...db.parampara[i], ...req.body };
  ok(res, db.parampara[i], 'Parampara entry updated');
});
app.delete('/api/admin/parampara/:id', adminAuth, (req, res) => {
  const i = (db.parampara || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return err(res, 'Not found', 404);
  const deleted = db.parampara.splice(i, 1)[0];
  ok(res, deleted, 'Parampara entry deleted');
});

app.get('/api/admin/live-lectures', adminAuth, (req, res) => ok(res, db.liveLectures || []));
app.post('/api/admin/live-lectures', adminAuth, (req, res) => {
  const { title, speaker, startAt, endAt, platform, joinUrl, description, notify } = req.body || {};
  if (!title || !startAt) return err(res, 'title and startAt required');

  const parsedStart = new Date(startAt);
  if (Number.isNaN(parsedStart.getTime())) return err(res, 'startAt must be a valid date and time');
  const dayInIndia = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(parsedStart);
  if (dayInIndia !== 'Sunday') return err(res, 'Sunday class schedules must use a Sunday date');
  if (!joinUrl || !/^https:\/\/(www\.)?zoom\.us\//i.test(joinUrl.toString().trim())) {
    return err(res, 'A valid Zoom meeting link is required');
  }

  const safeTitle = title.toString().trim();

  const item = {
    id: uuidv4(),
    title: safeTitle,
    speaker: (speaker || '').toString().trim(),
    startAt: startAt.toString().trim(),
    endAt: (endAt || '').toString().trim(),
    platform: 'Zoom',
    joinUrl: joinUrl.toString().trim(),
    description: (description || '').toString().trim(),
    sundayClass: true,
    createdAt: new Date().toISOString()
  };

  db.liveLectures.unshift(item);

  if (notify === true) {
    const n = pushNotif('lecture', 'Live Lecture Scheduled', `${item.title}${item.speaker ? ' — ' + item.speaker : ''} (${item.startAt})`, '📖', 'admin');
    sendWebPushToAll({ title: n.title, body: n.body, iconUrl: '/iskcon-logo.png', url: '/' }).catch(()=>{});
  }

  ok(res, item, 'Live lecture added');
});
app.put('/api/admin/live-lectures/:id', adminAuth, (req, res) => {
  const i = (db.liveLectures || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return err(res, 'Not found', 404);
  db.liveLectures[i] = { ...db.liveLectures[i], ...req.body, id:db.liveLectures[i].id, updatedAt: new Date().toISOString() };
  ok(res, db.liveLectures[i], 'Live lecture updated');
});
app.delete('/api/admin/live-lectures/:id', adminAuth, (req, res) => {
  const i = (db.liveLectures || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return err(res, 'Not found', 404);
  const deleted = db.liveLectures.splice(i, 1)[0];
  ok(res, deleted, 'Live lecture deleted');
});

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  ok(res, {
    stats: db.stats,
    counts: { events:db.events.length, trips:db.trips.length, notifications:db.notifications.length, donations:db.donations.length, volunteers:db.volunteers.length, newsletter:db.newsletter.length, liveClients:db.sseClients.length, pushSubscriptions:(db.pushSubs || []).length },
    recentDonations: db.donations.slice(0,10),
    recentVolunteers: db.volunteers.slice(0,10),
    notifications: db.notifications.slice(0,30),
    liveStream: db.liveStream,
    events: db.events,
    notices: db.notices
  });
});

app.post('/api/admin/events', adminAuth, (req, res) => {
  const body = req.body || {};
  const categories = new Set(['festival', 'yatra', 'lecture', 'meeting']);
  if (!String(body.title || '').trim() || !categories.has(body.category) || !body.time || !body.location || !String(body.description || '').trim() || !isUpcomingEvent(body)) {
    return err(res, 'Add a title, confirmed category, future date, time, location, and programme details.');
  }
  if (body.seats !== undefined && (!Number.isInteger(Number(body.seats)) || Number(body.seats) < 1)) return err(res, 'Confirmed capacity must be a positive whole number.');
  const ev = { ...body, id:uuidv4(), registered:0, registrations:[], createdAt:new Date().toISOString() };
  ev.poster = buildEventPoster(ev);
  db.events.unshift(ev);
  pushNotif('event', 'New Event: ' + ev.title, ev.description || ev.title, ev.emoji||'📅', 'admin');
  broadcastUpdate('events');
  ok(res, ev, 'Event created!');
});

app.put('/api/admin/events/:id', adminAuth, (req, res) => {
  const i = db.events.findIndex(e=>e.id===req.params.id);
  if (i===-1) return err(res,'Not found',404);
  db.events[i] = { ...db.events[i], ...req.body, id:db.events[i].id };
  broadcastUpdate('events');
  ok(res, db.events[i], 'Event updated!');
});

app.delete('/api/admin/events/:id', adminAuth, (req, res) => {
  const i = db.events.findIndex(e=>e.id===req.params.id);
  if (i===-1) return err(res,'Not found',404);
  const title = db.events[i].title;
  db.events.splice(i,1);
  broadcastUpdate('events');
  ok(res, null, 'Event "' + title + '" deleted');
});

app.get('/api/admin/trips', adminAuth, (req, res) => {
  ok(res, (db.trips || []).map(trip => ({
    ...trip,
    completed:isTripCompleted(trip),
    status:isTripCompleted(trip) ? 'Completed' : (isUpcomingTrip(trip) ? 'Upcoming' : 'Invalid dates')
  })));
});

app.post('/api/admin/trips', adminAuth, (req, res) => {
  const { title, destination, startDate, days, price, seats, description } = req.body || {};
  const duration = Number(days);
  const cost = Number(price);
  const capacity = Number(seats);
  if (!String(title || '').trim() || !String(destination || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !Number.isInteger(duration) || duration < 1 || duration > 60 || !Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(cost) || cost < 0) {
    return err(res, 'Enter a title, destination, valid start date, duration (1–60 days), confirmed seat capacity, and non-negative price.');
  }
  const parsedStartDate = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(parsedStartDate.getTime()) || parsedStartDate.toISOString().slice(0, 10) !== startDate || startDate < nagdaToday()) {
    return err(res, 'Trip start date must be today or later, and must be a valid calendar date.');
  }
  const trip = {
    id:uuidv4(), title:String(title).trim(), destination:String(destination).trim(),
    startDate, days:duration, endDate:new Date(Date.parse(`${startDate}T00:00:00Z`) + (duration - 1) * 86400000).toISOString().slice(0, 10),
    price:Math.round(cost), description:String(description || '').trim(), badge:'Open', color:'#7B1E2E',
    seats:capacity, booked:0, bookings:[]
  };
  if (!isUpcomingTrip(trip)) return err(res, 'The trip dates are invalid or have already passed.');
  db.trips.push(trip);
  broadcastUpdate('trips');
  ok(res, trip, 'Confirmed yatra published.');
});

app.delete('/api/admin/trips/:id', adminAuth, (req, res) => {
  const index = db.trips.findIndex(trip => trip.id === req.params.id);
  if (index < 0) return err(res, 'Trip not found', 404);
  const [trip] = db.trips.splice(index, 1);
  broadcastUpdate('trips');
  ok(res, null, `Removed ${trip.title} from the trip list.`);
});

app.post('/api/admin/notices', adminAuth, (req, res) => {
  const n = { ...req.body, id:uuidv4(), postedAt:new Date().toISOString().split('T')[0] };
  db.notices.unshift(n);
  pushNotif('notice', 'New Notice: ' + n.title, n.body, '📋', 'admin');
  broadcastUpdate('notices');
  ok(res, n, 'Notice posted!');
});

app.delete('/api/admin/notices/:id', adminAuth, (req, res) => {
  const i = db.notices.findIndex(n=>n.id===req.params.id);
  if (i===-1) return err(res,'Not found',404);
  db.notices.splice(i,1);
  broadcastUpdate('notices');
  ok(res, null, 'Notice deleted');
});

app.put('/api/admin/live', adminAuth, (req, res) => {
  db.liveStream = { ...db.liveStream, ...req.body, updatedAt:new Date().toISOString() };
  if (req.body.isLive === true) pushNotif('live', 'We Are LIVE Now!', db.liveStream.currentProgram + ' is streaming now on YouTube!', '📺', 'admin');
  broadcastUpdate('live');
  ok(res, db.liveStream, 'Live stream updated!');
});

app.delete('/api/admin/notifications', adminAuth, (req, res) => {
  db.notifications = [];
  ok(res, null, 'All notifications cleared');
});

/* ─── PUBLIC ROUTES ─── */
function nagdaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

function isUpcomingEvent(event) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date || '')) return false;
  const parsed = new Date(`${event.date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== event.date) return false;
  return event.date >= nagdaToday();
}

function getFestivalSpotlight(today = nagdaToday()) {
  const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '');
  const active = [];
  const upcomingByKey = new Map();

  (db.vaisnavaCalendar || []).forEach(item => {
    const startDate = item.startDate || item.date;
    const endDate = item.endDate || item.date;
    if (!validDate(startDate) || !validDate(endDate)) return;

    if (startDate <= today && endDate >= today) {
      active.push(item);
    } else if (startDate > today) {
      const key = `${startDate}:${String(item.title || '').toLowerCase()}`;
      upcomingByKey.set(key, { ...item, date: startDate });
    }
  });

  (db.events || []).forEach(event => {
    if (!['festival', 'yatra'].includes(event.category) || !validDate(event.date) || event.date <= today) return;
    const key = `${event.date}:${String(event.title || '').toLowerCase()}`;
    if (!upcomingByKey.has(key)) {
      upcomingByKey.set(key, {
        id: event.id,
        title: event.title,
        date: event.date,
        type: event.category,
        notes: event.description || '',
        source: 'ISKCON Nagda Events'
      });
    }
  });

  const upcoming = [...upcomingByKey.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.title).localeCompare(String(b.title)))
    .map(item => ({
      ...item,
      daysUntil: Math.round((Date.parse(`${item.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
    }));

  return {
    asOf: today,
    active: active.sort((a, b) => (a.startDate || a.date).localeCompare(b.startDate || b.date)),
    upcoming: upcoming.slice(0, 5)
  };
}

function isUpcomingTrip(trip) {
  const dates = tripDateRange(trip);
  return Boolean(dates && dates.endDate >= nagdaToday());
}

function isTripCompleted(trip) {
  const dates = tripDateRange(trip);
  return Boolean(dates && dates.endDate < nagdaToday());
}

function tripDateRange(trip) {
  const startDate = String(trip.startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== startDate) return null;
  const days = Math.max(1, Math.floor(Number(trip.days) || 1));
  const calculatedEnd = new Date(start.getTime() + (days - 1) * 86400000).toISOString().slice(0, 10);
  const endDate = String(trip.endDate || calculatedEnd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) return null;
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== endDate) return null;
  return { startDate, endDate };
}

app.get('/api/events', (req,res) => {
  let list = db.events.filter(isUpcomingEvent).map(event => ({
    id:event.id, title:event.title, date:event.date, time:event.time, location:event.location,
    description:event.description, category:event.category, poster:event.poster || buildEventPoster(event),
    emoji:event.emoji, seats:event.seats, registered:Number(event.registered || 0), price:event.price
  }));
  if (req.query.category && req.query.category!=='all') list=list.filter(e=>e.category===req.query.category);
  if (req.query.search) { const q=req.query.search.toLowerCase(); list=list.filter(e=>e.title.toLowerCase().includes(q)); }
  ok(res, list);
});
app.get('/api/events/:id', (req,res) => {
  const e=db.events.find(e=>e.id===req.params.id);
  if (!e || !isUpcomingEvent(e)) return err(res,'Event not found',404);
  ok(res, { id:e.id, title:e.title, date:e.date, time:e.time, location:e.location, description:e.description,
    category:e.category, poster:e.poster || buildEventPoster(e), emoji:e.emoji, seats:e.seats,
    registered:Number(e.registered || 0), price:e.price });
});

app.get('/api/calendar', (req, res) => {
  let list = [...(db.vaisnavaCalendar || [])];
  if (req.query.upcoming !== 'false') list = list.filter(i => (i.endDate || i.date || '') >= nagdaToday());
  list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.title || '').localeCompare(b.title || ''));
  ok(res, list.map(({ id, title, date, endDate, type, description, fasting, parana, notes, compliment, source, sourceUrl }) => ({
    id, title, date, endDate, type, description, fasting, parana, notes, compliment, source, sourceUrl
  })));
});

app.get('/api/festivals/featured', (req, res) => {
  const spotlight = getFestivalSpotlight();
  const publicItem = item => ({ id:item.id, title:item.title, date:item.date, startDate:item.startDate,
    endDate:item.endDate, type:item.type, notes:item.notes, daysUntil:item.daysUntil,
    fasting:item.fasting, source:item.source, sourceUrl:item.sourceUrl });
  ok(res, { asOf:spotlight.asOf, active:spotlight.active.map(publicItem), upcoming:spotlight.upcoming.map(publicItem) });
});

app.get('/api/current-day-schedule', (req, res) => ok(res, (db.darshan || []).map(({ id, name, time, desc }) => ({ id, name, time, desc }))));

app.get('/api/parampara', (req, res) => {
  const list = [...(db.parampara || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  ok(res, list.map(({ id, name, role, period, order }) => ({ id, name, role, period, order })));
});

app.get('/api/live-lectures', (req, res) => {
  const now = Date.now();
  let list = [...(db.liveLectures || [])];
  if (req.query.upcoming === 'true') {
    list = list.filter(i => {
      const t = Date.parse(i.startAt || '');
      return Number.isFinite(t) ? t >= (now - 15 * 60 * 1000) : true;
    });
  }
  list.sort((a, b) => Date.parse(a.startAt || '') - Date.parse(b.startAt || ''));
  ok(res, list.map(({ id, title, speaker, startAt, duration, platform, description, joinUrl }) => ({ id, title, speaker, startAt, duration, platform, description, joinUrl })));
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validMobile(value) {
  return /^[6-9]\d{9}$/.test(value);
}

app.post('/api/events/:id/register', (req,res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const p = body.persons === undefined ? 1 : Number(body.persons);
  if (!name || !email || !phone) return err(res,'Name, email and phone required');
  if (name.length > 100) return err(res,'Name must be 100 characters or fewer');
  if (!validEmail(email)) return err(res,'Invalid email');
  if (!validMobile(phone)) return err(res,'Invalid mobile number');
  if (!Number.isInteger(p) || p < 1 || p > 10) return err(res,'Number of attendees must be between 1 and 10');
  const ev=db.events.find(e=>e.id===req.params.id);
  if (!ev) return err(res,'Event not found',404);
  if (!isUpcomingEvent(ev)) return err(res,'Registration is closed for this past event',400);
  if (ev.registrations.find(r=>r.email===email)) return err(res,'Already registered with this email');
  if (ev.seats && ev.registered+p>ev.seats) return err(res,'Not enough seats available');
  const reg={id:uuidv4(),name,email,phone,persons:p,registeredAt:new Date().toISOString()};
  ev.registrations.push(reg); ev.registered+=p; db.stats.totalRegistrations++;
  pushNotif('event','New Registration',name+' registered for '+ev.title,'🎟','system');
  broadcastUpdate('events');
  sendUserNotification({ email, phone, subject:'Registration confirmed: '+ev.title, text:`Hare Krishna ${name}! Your registration for ${ev.title} is confirmed.\n\nPersons: ${p}\n\nISKCON Nagda Community` });
  ok(res,{registrationId:reg.id,eventTitle:ev.title,name,persons:p},'Hare Krishna '+name+'! Registered for '+ev.title+' 🙏');
});

app.get('/api/trips', (req,res) => ok(res, db.trips.filter(isUpcomingTrip).map(trip => ({
  id:trip.id, title:trip.title, description:trip.description, destination:trip.destination,
  startDate:trip.startDate, endDate:trip.endDate, days:trip.days, price:trip.price,
  seats:trip.seats, booked:Number(trip.booked || 0), image:trip.image
}))));
app.post('/api/trips/:id/book', (req,res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const p = body.persons === undefined ? 1 : Number(body.persons);
  if (!name||!email||!phone) return err(res,'All fields required');
  if (name.length > 100) return err(res,'Name must be 100 characters or fewer');
  if (!validEmail(email)) return err(res,'Invalid email');
  if (!validMobile(phone)) return err(res,'Invalid mobile');
  if (!Number.isInteger(p) || p < 1 || p > 8) return err(res,'Number of pilgrims must be between 1 and 8');
  const trip=db.trips.find(t=>t.id===req.params.id);
  if (!trip) return err(res,'Trip not found',404);
  if (!isUpcomingTrip(trip)) return err(res,'Bookings are closed for this past trip',400);
  if (trip.booked+p>trip.seats) return err(res,'Only '+(trip.seats-trip.booked)+' seats remain');
  const booking={id:uuidv4(),name,email,phone,persons:p,totalCost:trip.price*p,bookedAt:new Date().toISOString()};
  trip.bookings.push(booking); trip.booked+=p;
  pushNotif('trip','New Trip Booking',name+' booked '+p+' seat(s) for '+trip.title,'✈️','system');
  broadcastUpdate('trips');
  sendUserNotification({ email, phone, subject:'Yatra booking request: '+trip.title, text:`Hare Bol ${name}! We received your booking request for ${trip.title}.\n\nPilgrims: ${p}\nEstimated total: Rs ${booking.totalCost}\n\nThe temple team will contact you to confirm availability and payment details. This is not a payment receipt.\n\nISKCON Nagda Community` });
  ok(res,{bookingId:booking.id,trip:trip.title,totalCost:booking.totalCost,persons:p},'Your booking request for '+trip.title+' has been received. The temple team will contact you to confirm availability.');
});

app.get('/api/lectures', (req,res) => {
  let list=[...db.lectures];
  if (req.query.category && req.query.category!=='all') list=list.filter(l=>l.category===req.query.category);
  ok(res,list.map(({ id, title, speaker, date, category, description, duration, videoUrl }) => ({ id, title, speaker, date, category, description, duration, videoUrl })));
});

app.get('/api/meetings', (req,res) => ok(res, db.meetings.map(meeting => ({
  id:meeting.id, title:meeting.title, date:meeting.date, time:meeting.time,
  location:meeting.location, description:meeting.description, category:meeting.category
}))));
app.post('/api/meetings/:id/rsvp', (req,res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  if (!name||!email) return err(res,'Name and email required');
  if (name.length > 100) return err(res,'Name must be 100 characters or fewer');
  if (!validEmail(email)) return err(res,'Invalid email');
  if (phone && !validMobile(phone)) return err(res,'Invalid mobile number');
  const mt=db.meetings.find(m=>m.id===req.params.id);
  if (!mt) return err(res,'Meeting not found',404);
  if (mt.rsvps.find(r=>r.email===email)) return err(res,'Already RSVP\'d');
  mt.rsvps.push({id:uuidv4(),name,email,phone,at:new Date().toISOString()});
  broadcastUpdate('meetings');
  sendUserNotification({ email, phone, subject:'RSVP confirmed: '+mt.title, text:`Hare Krishna ${name}! Your RSVP for ${mt.title} is confirmed.\n\nISKCON Nagda Community` });
  ok(res,{meeting:mt.title,name},'Confirmed! See you at '+mt.title+' 🙏');
});

app.get('/api/notices', (req,res) => ok(res, (db.notices || []).map(({ id, title, body, description, postedAt, createdAt, category }) => ({ id, title, body, description, postedAt, createdAt, category }))));
app.get('/api/updates', (req, res) => {
  const notices = (db.notices || []).map(item => ({
    id: `notice-${item.id}`, type: 'notice', title: item.title || 'Temple notice',
    body: item.body || item.description || '', date: item.postedAt || item.createdAt || ''
  }));
  const events = (db.events || []).filter(isUpcomingEvent).map(item => ({
    id: `event-${item.id}`, type: 'event', title: item.title || 'Temple programme',
    body: item.description || '', date: item.date || item.createdAt || ''
  }));
  ok(res, [...notices, ...events].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8));
});
app.get('/api/darshan', (req,res) => ok(res, (db.darshan || []).map(({ id, name, time, desc, icon }) => ({ id, name, time, desc, icon }))));
app.get('/api/live', (req,res) => {
  const live = db.liveStream || {};
  ok(res, { isLive:!!live.isLive, currentProgram:live.currentProgram || '', embedId:live.embedId || '',
    viewerCount:Number(live.viewerCount || 0), updatedAt:live.updatedAt || '',
    channelUrl:YOUTUBE_CHANNEL_URL, liveUrl:YOUTUBE_LIVE_URL });
});
app.get('/api/youtube/latest', async (req, res) => {
  try {
    const result = await syncYouTubeFeed({ notify: false });
    ok(res, { latest:result.latest || [], channelUrl:YOUTUBE_CHANNEL_URL, liveUrl:YOUTUBE_LIVE_URL });
  } catch (error) {
    console.error('[youtube] Feed unavailable:', error.message);
    ok(res, { latest: youtubeLatest, channelUrl: YOUTUBE_CHANNEL_URL, liveUrl: YOUTUBE_LIVE_URL });
  }
});

app.post('/api/donate', (req,res) => {
  err(res, 'Online donations are not configured. Contact the temple office for verified payment details.', 503);
});

app.post('/api/volunteer', (req,res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const area = String(body.area || '').trim();
  const availability = String(body.availability || '').trim();
  if (!name||!email||!phone||!area) return err(res,'All fields required');
  if (name.length > 100 || area.length > 100 || availability.length > 200) return err(res,'One or more fields are too long');
  if (!validEmail(email)) return err(res,'Invalid email');
  if (!validMobile(phone)) return err(res,'Invalid mobile number');
  if (db.volunteers.find(v=>v.email===email)) return err(res,'Already registered as volunteer');
  const vol={id:uuidv4(),name,email,phone,area,availability,joinedAt:new Date().toISOString()};
  db.volunteers.push(vol); db.stats.totalVolunteers++;
  pushNotif('volunteer','New Volunteer',name+' signed up for '+area,'🙏','system');
  broadcastUpdate('volunteers');
  sendUserNotification({ email, phone, subject:'Volunteer registration confirmed', text:`Hare Krishna ${name}! Your volunteer registration for ${area} is confirmed.\n\nAvailability: ${availability || 'To be arranged'}\n\nThe temple team will contact you with the next seva details.` });
  ok(res,{volunteerId:vol.id,name,area},'Hare Krishna '+name+'! Welcome for '+area+' 🙏');
});

app.post('/api/newsletter', (req,res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!validEmail(email)) return err(res,'Valid email required');
  if (name.length > 100) return err(res,'Name must be 100 characters or fewer');
  if (db.newsletter.find(n=>n.email===email)) return err(res,'Already subscribed');
  db.newsletter.push({id:uuidv4(),email,name:name||'',subscribedAt:new Date().toISOString()});
  broadcastUpdate('newsletter');
  sendUserEmail({ to:email, subject:'Welcome to the ISKCON Nagda newsletter', text:`Hare Krishna${name ? ` ${name}` : ''}! You are now subscribed to ISKCON Nagda Community updates, festivals, seva opportunities and devotional programs.` });
  ok(res,{email},'Subscribed! Hare Krishna! 🙏');
});

app.get('/api/push/public-key', (req, res) => ok(res, { publicKey: vapid.publicKey }));

app.post('/api/push/subscribe', (req, res) => {
  const { subscription, name } = req.body || {};
  if (!isValidSubscription(subscription)) return err(res, 'Invalid subscription');

  const endpoint = subscription.endpoint;
  db.pushSubs = (db.pushSubs || []).filter(s => (s && s.subscription && s.subscription.endpoint) !== endpoint);
  db.pushSubs.unshift({
    id: uuidv4(),
    name: (name || '').toString().trim(),
    subscription,
    createdAt: new Date().toISOString(),
    userAgent: (req.headers['user-agent'] || '').toString()
  });
  if (db.pushSubs.length > 2000) db.pushSubs.pop();
  persistPushSubscriptions();

  ok(res, { subscribed: true }, 'Notifications enabled. Hare Krishna!');
});

app.get('/api/users', adminAuth, (req,res) => {
  const usersByKey = new Map();

  function normalizeName(raw) {
    return (raw || '').toString().replace(/\s+/g, ' ').trim();
  }

  function addUser({ name, email, phone }) {
    let finalName = normalizeName(name);
    const finalEmail = (email || '').toString().trim().toLowerCase();
    const finalPhone = (phone || '').toString().trim();

    if (!finalName && finalEmail) finalName = finalEmail.split('@')[0] || '';
    if (!finalName) return;

    const key = finalEmail || (finalName.toLowerCase() + (finalPhone ? `:${finalPhone}` : ''));
    if (!key) return;

    const existing = usersByKey.get(key);
    if (existing) {
      if (!existing.email && finalEmail) existing.email = finalEmail;
      if (!existing.phone && finalPhone) existing.phone = finalPhone;
      return;
    }

    usersByKey.set(key, {
      key: crypto.createHash('sha256').update(key).digest('hex'),
      name: finalName
    });
  }

  (db.events || []).forEach(ev => (ev.registrations || []).forEach(addUser));
  (db.trips || []).forEach(t => (t.bookings || []).forEach(addUser));
  (db.meetings || []).forEach(m => (m.rsvps || []).forEach(addUser));
  (db.donations || []).forEach(addUser);
  (db.volunteers || []).forEach(addUser);
  (db.newsletter || []).forEach(addUser);

  const list = Array.from(usersByKey.values()).sort((a, b) => a.name.localeCompare(b.name));
  ok(res, list);
});

app.get('/api/notifications', (req,res) => ok(res, db.notifications.filter(n => n.sentBy === 'admin').slice(0,30)));
app.post('/api/notifications/read', adminAuth, (req,res) => { db.notifications.forEach(n=>n.read=true); ok(res,null,'All read'); });

app.get('/api/stats', (req,res) => ok(res,{
  upcomingEvents:db.events.filter(isUpcomingEvent).length, liveNow:!!db.liveStream.isLive,
  viewers:Number(db.liveStream.viewerCount || 0)
}));

app.post('/api/chat', (req,res) => {
  const message = String((req.body || {}).message || '').trim();
  if (!message) return err(res,'Message required');
  if (message.length > 1000) return err(res,'Message must be 1000 characters or fewer');
  const m=message.toLowerCase();
  const spotlight = getFestivalSpotlight();
  const calendarMatch = (pattern, upcomingOnly = true) => (db.vaisnavaCalendar || []).find(item =>
    pattern.test(item.title || '') && (!upcomingOnly || (item.endDate || item.date || '') >= spotlight.asOf)
  );
  const datedAnswer = item => item
    ? `The published calendar lists ${item.title} on ${item.date}. Please confirm the local temple program.`
    : 'A date is not currently published in the temple calendar. Please check the calendar section for updates.';
  const festivalKnowledge = [
    {
      matches: ['kartik', 'kartika', 'damodara month', 'damodar month', 'damodarashtakam', 'damodara ashtakam', 'damodar astam', 'damodar ashtami'],
      answer: () => {
        const month = spotlight.active.find(item => /kartik|damodar/i.test(item.title || ''));
        const status = month
          ? `Kartik / Damodara month is active through ${month.endDate || month.date}.`
          : 'Kartik / Damodara month is not currently marked as active in the calendar.';
        const next = spotlight.upcoming.slice(0, 3).map(item => `• ${item.title} — ${item.date}`).join('\n');
        return `🪔 **Kartik (Damodara) Month**\n${status}\n\nDevotees use this especially sacred month to increase hearing, chanting and service. A common offering is a lamp to Krishna while singing or hearing the Damodarashtakam, which remembers Mother Yashoda lovingly binding child Krishna. Follow your local temple's guidance for the daily program.\n\n**Coming up:**\n${next || 'No future observances are currently listed.'}`;
      }
    },
    {
      matches: ['govardhan', 'annakuta', 'annakoot'],
      answer: () => {
        const item = calendarMatch(/govardhan|annakuta|annakoot/i);
        return `⛰️ **Govardhana Puja**\nThis festival remembers Krishna lifting Govardhana Hill to shelter the people and cows of Vraja. Devotees celebrate with Govardhana worship, kirtan and an Annakuta offering of many food preparations.\n\n${datedAnswer(item)} Offerings and fasting are best followed according to the local temple's instructions.`;
      }
    },
    {
      matches: ['janmashtami', 'krishna janmashtami'],
      answer: () => `🪷 **Sri Krishna Janmashtami**\nJanmashtami celebrates the appearance of Lord Sri Krishna. ISKCON temples commonly observe the day with kirtan, readings from Krishna's pastimes, abhisheka and a midnight celebration. Fasting and the time of breaking it vary by local calendar and temple guidance.\n\n${datedAnswer(calendarMatch(/janmashtami/i))}`
    },
    {
      matches: ['gaura purnima', 'gaur purnima'],
      answer: () => `🌕 **Gaura Purnima**\nGaura Purnima celebrates the appearance of Sri Chaitanya Mahaprabhu, who taught the congregational chanting of Krishna's names. Devotees mark the day with kirtan, readings, worship and prasadam. Follow the local temple for fasting guidance.\n\n${datedAnswer(calendarMatch(/gaura purnima/i))}`
    },
    {
      matches: ['rath yatra', 'ratha yatra', 'jagannath festival'],
      answer: () => `🎡 **Ratha Yatra**\nRatha Yatra is the joyful chariot festival of Lord Jagannatha, Lord Baladeva and Subhadra Devi. Devotees pull the decorated chariots, sing kirtan and share prasadam. Local routes and dates are set by each temple.\n\n${datedAnswer(calendarMatch(/ratha yatra/i))}`
    },
    {
      matches: ['narasimha', 'narasimhadeva'],
      answer: () => `🦁 **Narasimha Chaturdashi**\nThis appearance festival honors Lord Narasimhadeva, who protected Prahlada Maharaja. Devotees hear Prahlada's story, chant and worship the Lord; follow the temple's instructions for the observance.\n\n${datedAnswer(calendarMatch(/narasimha/i))}`
    },
    {
      matches: ['ekadashi', 'ekadasi'],
      answer: () => {
        const item = spotlight.upcoming.find(entry => /ekadashi|ekadasi/i.test(entry.title || ''));
        return `🙏 **Ekadashi**\nEkadashi is observed on the eleventh lunar day and is dedicated to remembrance of Lord Hari through chanting, hearing and service. Many devotees avoid grains and beans, but fasting practices differ; consider your health and follow your guru and local temple's guidance.\n\n${item ? `The next listed observance is ${item.title} on ${item.date}.` : 'No upcoming Ekadashi date is currently listed.'}`;
      }
    },
    {
      matches: ['hare krishna mantra', 'maha mantra', 'chanting', 'japa'],
      answer: () => `📿 **Hare Krishna Maha-mantra**\nThe mantra is: Hare Krishna, Hare Krishna, Krishna Krishna, Hare Hare / Hare Rama, Hare Rama, Rama Rama, Hare Hare. ISKCON encourages chanting with attention and devotion, individually on japa beads and together in kirtan. Beginners can start by listening carefully and chanting at a comfortable pace.`
    },
    {
      matches: ['prabhupada', 'founder', 'iskcon', 'krishna consciousness'],
      answer: () => `🙏 **About ISKCON**\nISKCON is the International Society for Krishna Consciousness, founded in 1966 by A.C. Bhaktivedanta Swami Prabhupada. It belongs to the Gaudiya Vaishnava tradition and shares teachings centered on devotion to Krishna, especially through the Bhagavad-gita, Srimad Bhagavatam, the Hare Krishna maha-mantra, devotional service, and prasadam. Temples and communities offer worship, kirtan, classes, festivals and service opportunities.`
    },
    {
      matches: ['bhagavad gita', 'gita'],
      answer: () => `📖 **Bhagavad-gita**\nThe Bhagavad-gita is Krishna's guidance to Arjuna on duty, the self, yoga and devotion. In ISKCON, it is studied as a practical guide to bhakti-yoga and loving service to Krishna. You can explore the site's lecture section or ask me about a particular topic or verse.`
    }
  ];
  const knowledge = festivalKnowledge.find(topic => topic.matches.some(term => m.includes(term)));

  // Dynamic responses using current data
  let reply = 'Hare Krishna! I can help with darshan timings, events, trips, donations, live streaming, or temple information. What would you like to know?';

  // Greetings
  if (/(^|\W)(hare|hari|hello|hi|namaste|jai|good morning|good evening)(?=$|\W)/.test(m)) {
    reply = '🙏 Hare Krishna! Welcome to ISKCON Nagda Community. I am Gopal, your devotional assistant. How may I serve you today?';
  }

  else if (knowledge) {
    reply = knowledge.answer();
  }

  // Darshan timings
  else if (['darshan','timing','aarti','open','close','time','schedule'].some(w=>m.includes(w))) {
    const darshans = db.darshan.map(d => `• ${d.name} — ${d.time}`).join('\n');
    reply = `🪔 **Current Darshan Timings:**\n${darshans}\n\nAll timings are IST. Live streaming available for major aartis!`;
  }

  // Events
  else if (['event','festival','upcoming','today','happening','program','celebration'].some(w=>m.includes(w))) {
    const events = spotlight.upcoming.slice(0,5).map(item => `• ${item.title} — ${item.date}`).join('\n') || 'No upcoming festivals or observances are listed right now.';
    const active = spotlight.active.map(item => `• ${item.title}${item.endDate ? ` (through ${item.endDate})` : ''}`).join('\n');
    reply = `🎉 **ISKCON Calendar**\n${active ? `**Being observed now:**\n${active}\n\n` : ''}**Coming up:**\n${events}\n\nDates follow the published calendar; confirm local program details with the temple.`;
  }

  // Trips
  else if (['trip','vrindavan','dwaraka','mayapur','pilgrim','yatra','travel'].some(w=>m.includes(w))) {
    const trips = db.trips.filter(isUpcomingTrip).map(t => `• ${t.title} — ${t.startDate}, ${t.days} days (₹${t.price})`).join('\n') || 'No upcoming trips are listed right now.';
    reply = `Devotional trips and yatras:\n${trips}\n\nDetails such as accommodation and meals are provided only when confirmed for a specific trip.`;
  }

  // Donations
  else if (['donat','daan','money','give','support','contribute','fund'].some(w=>m.includes(w))) {
    reply = 'Use the UPI donation QR shown in the Donate section. Check the recipient name in your UPI app before approving the payment. The website cannot verify UPI payments or issue a receipt.';
  }

  // Live streaming
  else if (['live','stream','watch','youtube','online','broadcast'].some(w=>m.includes(w))) {
    const live = db.liveStream;
    reply = live.isLive
      ? `📺 **Currently Live:** ${live.currentProgram} (${live.viewerCount} viewers)\n\nWatch now in the Live section or on YouTube!`
      : 'No stream is currently marked live. Check the Live section for a confirmed stream announcement.';
  }

  // Location
  else if (['address','where','location','reach','map','direction','contact'].some(w=>m.includes(w))) {
    reply = `**ISKCON Nagda Community**`;
  }

  // Prasadam
  else if (['prasad','food','meal','eat','lunch','dinner','bhog'].some(w=>m.includes(w))) {
    reply = 'Prasadam availability and serving times vary by programme. Please contact the temple for today’s confirmed details.';
  }

  // Volunteer
  else if (['volunteer','seva','help','serve','work','assist'].some(w=>m.includes(w))) {
    reply = `🤝 **Volunteer Opportunities:**\n• Prasadam distribution\n• Flower arrangement\n• Kirtan and bhajans\n• Book distribution\n• Security and logistics\n• Media and photography\n\nRegister in the Volunteer section. Your seva is valuable!`;
  }

  // Notices
  else if (['notice','announcement','news','update','information'].some(w=>m.includes(w))) {
    const notices = db.notices.slice(0,2).map(n => `• ${n.title}`).join('\n');
    reply = `📋 **Latest Notices:**\n${notices}\n\nCheck the Meetings & Notices section for full details.`;
  }

  // Public summary
  else if (['stats','statistics','numbers','count','total'].some(w=>m.includes(w))) {
    reply = `The website currently lists ${db.events.filter(isUpcomingEvent).length} confirmed upcoming event(s). Please check Events and Notices for current temple updates.`;
  }

  // Help
  else if (['help','what','how','guide','assist'].some(w=>m.includes(w))) {
    reply = `🙏 **I can help you with:**\n• 🪔 Darshan timings and schedule\n• 🎡 Upcoming events and festivals\n• 🌿 Devotional trips and pilgrimages\n• 💛 Donations and contributions\n• 📺 Live streaming information\n• 📍 Temple location and directions\n• 🍛 Prasadam and meal information\n• 🤝 Volunteer opportunities\n• 📋 Latest notices and announcements\n• 📊 Community statistics\n\nJust ask me anything! Hare Krishna!`;
  }

  ok(res,{reply});
});

app.use('/api', (req, res) => err(res, 'This request is unavailable.', 404));
app.use((error, req, res, next) => {
  console.error('[server] Request failed:', error && error.message ? error.message : 'Unknown error');
  if (res.headersSent) return next(error);
  err(res, 'Something went wrong. Please try again later.', 500);
});

syncYouTubeFeed({ notify: false }).catch(error => console.error('[youtube] Initial sync failed:', error.message));
cron.schedule('*/10 * * * *', () => {
  syncYouTubeFeed().catch(error => console.error('[youtube] Scheduled sync failed:', error.message));
});

app.listen(PORT, () => {
  console.log('\n🙏 ISKCON Nagda Community Server v3.0 — http://localhost:' + PORT);
  console.log('Public site: http://localhost:' + PORT + '/');
  console.log('Admin panel: http://localhost:' + PORT + '/admin');
  console.log('SSE stream: GET /api/stream');
  console.log('Push notify: POST /api/admin/notify (requires X-Admin-Password)');
});
