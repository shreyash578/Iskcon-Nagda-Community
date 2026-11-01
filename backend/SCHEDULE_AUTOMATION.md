# ISKCON Nagda Schedule Automation

This backend updates `backend/current_day_schedule.json` automatically every day at `12:01 AM` India time.

## Install

```bash
cd backend
npm install
npm start
```

If PowerShell blocks `npm`, run:

```powershell
cd backend
npm.cmd install
npm.cmd start
```

## Calendar Source

Set `VAISNAVA_CALENDAR_URL` to a JSON calendar feed that returns current or year-level Vaishnava calendar data. The URL may contain these placeholders:

```text
{date} {year} {lat} {lng} {timezone}
```

Example:

```powershell
$env:VAISNAVA_CALENDAR_URL="https://your-calendar-service.example/api/calendar?year={year}&lat={lat}&lng={lng}&timezone={timezone}"
npm.cmd start
```

Optional bearer token:

```powershell
$env:VAISNAVA_CALENDAR_TOKEN="your-token"
```

The feed can return any of these shapes:

```json
[
  {
    "date": "2026-06-01",
    "type": "ekadashi",
    "name": "Nirjala Ekadashi",
    "fasting_rules": "Full fast, or no grains/beans as per capacity",
    "parana_time": "05:43 AM - 08:09 AM"
  },
  {
    "date": "2026-09-04",
    "type": "festival",
    "name": "Krishna Janmashtami"
  }
]
```

It also accepts `{ "calendar": [...] }`, `{ "events": [...] }`, or `{ "data": [...] }`.

## Local Verified Overrides

Add verified temple entries to `backend/vaisnava_calendar_overrides.json` using the same item format. Remote API data and local overrides are merged every night.
Multi-day observances can use `startDate` and `endDate` in `YYYY-MM-DD` format; they remain active through the end date and then disappear from current highlights automatically.

## Public API

The website can read the generated schedule from:

```text
GET /api/current-day-schedule
GET /api/calendar
GET /api/festivals/featured
```

The featured response contains observances active today and the next five dated calendar items. The website refreshes these at Nagda midnight and when a suspended tab becomes visible again. Add future verified dates to the local calendar or configure `VAISNAVA_CALENDAR_URL` to keep upcoming highlights populated beyond the dates already published.

## Failure Behavior

If the remote calendar source fails, the scheduler logs the error and writes a safe static daily routine so the website continues to work.
