---
'@spaces/plugin-exa': minor
---

Exa watches a space. A watch on a space, with Exa as its engine, creates one Exa webset on its first run from the space's brief — the watch's own criteria, or the space's when left blank, the nearest memo, and the domains of the companies filed there as exemplars — and keeps the webset's id and its page cursor as the watch's state. Every run pages the webset from that cursor and stops at the watch's cap (10 companies a run by default) with the cursor where it stopped. A company already filed in the space becomes a web signal on it, keyed on its URL so a re-run writes nothing new; any other company goes to the host as a candidate, with the pages Exa found it on as evidence, and waits in Review as a card under the space. Every answer Exa gives is kept as a receipt on the space, and Exa's own error text is shown when a call fails.
