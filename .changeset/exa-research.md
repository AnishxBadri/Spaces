---
'@spaces/plugin-exa': minor
---

Exa researches a company. With a workspace search key, a Research button on a company searches the web through Exa for the company's name and domain, within the last `lookbackDays` (90 by default) and up to `maxResults` pages (5 by default). Each page becomes a web signal on the record, keyed on its URL so a second run writes nothing new. A short brief citing those signals waits in Review as a note to accept. Exa's own error text is shown when a search fails. Without a key the button does not appear.
