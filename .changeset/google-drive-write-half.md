---
'@spaces/plugin-google-drive': minor
---

Google Drive implements the write half: `ensureFolder` creates a path's missing folders and, when racing calls create the same name, every caller takes the oldest and the losers delete their own; `putFile` uploads in resumable 8 MiB chunks under the upload's own mime (never converted), as a revision of a same-sha file under the name or as `name (2).ext`; `move` and `rename` send nothing when the file is already there or so named. Needs sdk ^1.5.
