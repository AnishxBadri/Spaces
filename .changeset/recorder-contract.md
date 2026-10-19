---
'@spaces/sdk': minor
'spaces': patch
---

One recorder contract for every note-taker (D78). `Content.logRecordedNote` takes a `RecordedNote` — the provider's note id, title, start and end, attendees, the calendar event id when the recorder knows it, the enhanced summary, the typed notes and transcript when the member opted in, the note's link, a recording link, its folders and `deletedAt` — or a `RecordedNoteGone` naming a note that left every shared folder. The host matches the note to the calendar meeting by event id, else by start time and attendees within 30 minutes, else files a call; the same note delivered twice is one interaction, keyed per member, and a gone or deleted note takes Spaces' copy with it. A manifest's `requires.connection` may be `{ provider, key: true }`: each member pastes their own key, and the host runs the plugin's schedule jobs once per member's connection, each from its own cursor and handed that connection's settings as `ScheduleInput.connection` (`keyedProviderOf` reads it). The testing kit's `ContentTest` keys recorded notes on their id, and `makeFakeGranolaApi` is Granola's read-only notes API over a fake member's folders, with a request log.
