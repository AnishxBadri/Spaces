---
'@spaces/plugin-google-calendar': minor
---

Google Calendar, the first syncer. Every fifteen minutes it reads the connected user's primary calendar — from the day the connection was made on the first run, and from Google's sync token after that — and hands each event to the host, which keeps the external meetings on the timelines of the people and companies in them. A changed event moves its meeting in place; a cancelled one is marked. When Google expires the sync token the next run starts again from the connection date, never from the beginning of the calendar. Asks only `calendar.events.readonly`. Needs sdk ^1.5.
