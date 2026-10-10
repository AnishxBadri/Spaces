---
'@spaces/sdk': minor
'spaces': patch
---

A recorder can hand the host its payload. `Content.logInteraction` takes `participants` — people by address, run through the same participants module mail and the calendar arrive through — and a `recorder` payload: the provider's event id, the meeting's `icalUid` or `calendarEventId` when the recorder knows them, the raw payload and its artifacts (a recording kept as a link, or a transcript the plugin filed). The host stores the payload as a receipt before anything else, then attaches it to the calendar meeting it names — or the one starting within 30 minutes whose attendees include every participant — or, when nothing matches, files one call per provider event, so a payload delivered twice is one row. A recorder claim carries no body: what its notes become is the host's. A fifth domain event, `interaction.logged`, names each company or person that became a participant of a meeting or call; the meeting auto-enrich scope runs on it. The testing kit's `ContentTest` attaches a recorder payload to the meeting its key names.
