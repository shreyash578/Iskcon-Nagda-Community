const cron = require('node-cron');
const fs = require('fs/promises');
const path = require('path');

const NAGDA = {
  name: 'Nagda, Madhya Pradesh, India',
  latitude: 23.4474,
  longitude: 75.3813,
  timezone: 'Asia/Kolkata'
};

const OUTPUT_FILE = path.join(__dirname, 'current_day_schedule.json');
const OVERRIDES_FILE = path.join(__dirname, 'vaisnava_calendar_overrides.json');

const DAILY_ROUTINE = Object.freeze([
  { event: 'Mangala Arati', time: '04:30 AM' },
  { event: 'Tulsi Arati', time: '05:00 AM' },
  { event: 'Deity Greeting / Darshan', time: '07:15 AM' },
  { event: 'Guru Puja', time: '07:30 AM' },
  { event: 'Srimad Bhagavatam Class', time: '08:00 AM' },
  { event: 'Raj Bhoga Arati', time: '12:30 PM' },
  { event: 'Dhupa Arati', time: '04:15 PM' },
  { event: 'Sandhya / Gaura Arati', time: '07:00 PM' },
  { event: 'Sayana Arati', time: '08:30 PM' }
]);

const MAJOR_FESTIVAL_ALIASES = [
  'krishna janmashtami',
  'janmashtami',
  'radhashtami',
  'gaura purnima',
  'balaram jayanti',
  'balarama jayanti',
  'nityananda trayodashi'
];

function toIsoDate(date = new Date(), timeZone = NAGDA.timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatTime(date, timeZone = NAGDA.timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

// NOAA solar calculation. Accurate enough for schedule support and parana fallback windows.
function calculateSunTimeUtc(isoDate, zenithDegrees, isSunrise, location = NAGDA) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const dayOfYear = Math.floor((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 0))) / 86400000);
  const lngHour = location.longitude / 15;
  const approxTime = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = (0.9856 * approxTime) - 3.289;
  let trueLongitude = meanAnomaly
    + (1.916 * Math.sin(degToRad(meanAnomaly)))
    + (0.020 * Math.sin(2 * degToRad(meanAnomaly)))
    + 282.634;
  trueLongitude = normalizeDegrees(trueLongitude);

  let rightAscension = radToDeg(Math.atan(0.91764 * Math.tan(degToRad(trueLongitude))));
  rightAscension = normalizeDegrees(rightAscension);
  rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;

  const sinDec = 0.39782 * Math.sin(degToRad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (
    Math.cos(degToRad(zenithDegrees))
    - (sinDec * Math.sin(degToRad(location.latitude)))
  ) / (cosDec * Math.cos(degToRad(location.latitude)));

  if (cosHour > 1 || cosHour < -1) return null;

  let hourAngle = isSunrise
    ? 360 - radToDeg(Math.acos(cosHour))
    : radToDeg(Math.acos(cosHour));
  hourAngle /= 15;

  const localMeanTime = hourAngle + rightAscension - (0.06571 * approxTime) - 6.622;
  const utcHour = normalizeHours(localMeanTime - lngHour);
  const utcDate = new Date(date);
  utcDate.setUTCHours(Math.floor(utcHour), Math.floor((utcHour % 1) * 60), 0, 0);
  return utcDate;
}

function calculateNagdaSunTimes(isoDate) {
  const sunrise = calculateSunTimeUtc(isoDate, 90.833, true);
  const sunset = calculateSunTimeUtc(isoDate, 90.833, false);
  return {
    sunrise,
    sunset,
    sunriseLabel: sunrise ? formatTime(sunrise) : null,
    sunsetLabel: sunset ? formatTime(sunset) : null
  };
}

function fallbackParanaWindow(isoDate) {
  const nextDay = addDays(isoDate, 1);
  const { sunrise } = calculateNagdaSunTimes(nextDay);
  if (!sunrise) return null;
  const end = new Date(sunrise.getTime() + (2 * 60 + 24) * 60000);
  return `${formatTime(sunrise)} - ${formatTime(end)}`;
}

function degToRad(degrees) {
  return degrees * Math.PI / 180;
}

function radToDeg(radians) {
  return radians * 180 / Math.PI;
}

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function normalizeHours(hours) {
  return ((hours % 24) + 24) % 24;
}

function normalizeSourceItem(item) {
  const name = item.name || item.title || item.summary || '';
  const lowerName = name.toLowerCase();
  const type = (item.type || item.category || '').toLowerCase();
  const isEkadashi = item.is_ekadashi === true || item.isEkadashi === true || type.includes('ekadashi') || lowerName.includes('ekadashi');
  const isFestival = item.is_festival === true || item.isFestival === true || type.includes('festival') || type.includes('observance') || MAJOR_FESTIVAL_ALIASES.some(alias => lowerName.includes(alias));

  return {
    date: item.date || item.startDate || item.start || item.when,
    startDate: item.startDate || item.date || item.start || item.when,
    endDate: item.endDate || item.date || item.startDate || item.start || item.when,
    isEkadashi,
    ekadashiName: isEkadashi ? (item.ekadashi_name || item.ekadashiName || name || 'Ekadashi') : null,
    fastingRules: item.fasting_rules || item.fastingRules || item.fasting || item.fast || null,
    paranaTime: item.parana_time || item.paranaTime || item.parana || item.break_fast || item.breakFast || null,
    isFestival,
    festivalName: isFestival ? (item.festival_name || item.festivalName || name || 'Festival') : null
  };
}

function pickSourcePayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (Array.isArray(payload && payload.events)) return payload.events;
  if (Array.isArray(payload && payload.calendar)) return payload.calendar;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

async function loadLocalOverrides() {
  try {
    const raw = await fs.readFile(OVERRIDES_FILE, 'utf8');
    return pickSourcePayload(JSON.parse(raw)).map(normalizeSourceItem);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[schedule] Failed to read local overrides:', error.message);
    return [];
  }
}

async function fetchCalendarSource(isoDate) {
  const template = process.env.VAISNAVA_CALENDAR_URL;
  if (!template) return [];

  const year = isoDate.slice(0, 4);
  const url = template
    .replaceAll('{date}', encodeURIComponent(isoDate))
    .replaceAll('{year}', encodeURIComponent(year))
    .replaceAll('{lat}', String(NAGDA.latitude))
    .replaceAll('{lng}', String(NAGDA.longitude))
    .replaceAll('{timezone}', encodeURIComponent(NAGDA.timezone));

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(process.env.VAISNAVA_CALENDAR_TOKEN ? { Authorization: `Bearer ${process.env.VAISNAVA_CALENDAR_TOKEN}` } : {})
    }
  });

  if (!response.ok) throw new Error(`Calendar source failed: ${response.status} ${response.statusText}`);
  return pickSourcePayload(await response.json()).map(normalizeSourceItem);
}

function selectDayData(items, isoDate) {
  const isOnDate = (item, date) => (item.startDate || item.date) <= date && (item.endDate || item.date) >= date;
  const todayItems = items.filter(item => isOnDate(item, isoDate));
  const tomorrowItems = items.filter(item => isOnDate(item, addDays(isoDate, 1)));
  const ekadashi = todayItems.find(item => item.isEkadashi) || tomorrowItems.find(item => item.isEkadashi);
  const festival = todayItems.find(item => item.isFestival && item.festivalName);

  return { ekadashi, festival };
}

function buildScheduleModel({ isoDate, ekadashi, festival }) {
  const isEkadashi = !!ekadashi;
  const paranaTime = isEkadashi
    ? (ekadashi.paranaTime || fallbackParanaWindow(ekadashi.date || isoDate))
    : null;

  return {
    date: isoDate,
    is_ekadashi: isEkadashi,
    ekadashi_name: isEkadashi ? ekadashi.ekadashiName : null,
    fasting_rules: isEkadashi ? (ekadashi.fastingRules || 'No grains/beans; follow temple guidance for full or partial fast.') : null,
    parana_time: paranaTime,
    is_festival: !!festival,
    festival_name: festival ? festival.festivalName : null,
    daily_routine: DAILY_ROUTINE.map(item => ({ ...item }))
  };
}

async function updateCurrentDaySchedule(date = new Date()) {
  const isoDate = typeof date === 'string' ? date : toIsoDate(date);

  try {
    const [remoteItems, localItems] = await Promise.all([
      fetchCalendarSource(isoDate).catch(error => {
        console.error('[schedule] Remote Vaishnava calendar unavailable:', error.message);
        return [];
      }),
      loadLocalOverrides()
    ]);

    const { ekadashi, festival } = selectDayData([...remoteItems, ...localItems], isoDate);
    const model = buildScheduleModel({ isoDate, ekadashi, festival });
    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
    console.log(`[schedule] current_day_schedule.json updated for ${isoDate}`);
    return model;
  } catch (error) {
    console.error('[schedule] Failed to build dynamic schedule, writing static fallback:', error);
    const fallback = buildScheduleModel({ isoDate, ekadashi: null, festival: null });
    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
    return fallback;
  }
}

async function readCurrentDaySchedule() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8'));
  } catch (error) {
    return updateCurrentDaySchedule();
  }
}

function initScheduleAutomation() {
  updateCurrentDaySchedule();

  return cron.schedule(
    '1 0 * * *',
    () => {
      updateCurrentDaySchedule().catch(error => {
        console.error('[schedule] Midnight cron failed:', error);
      });
    },
    { timezone: NAGDA.timezone }
  );
}

module.exports = {
  DAILY_ROUTINE,
  NAGDA,
  OUTPUT_FILE,
  initScheduleAutomation,
  readCurrentDaySchedule,
  updateCurrentDaySchedule
};
