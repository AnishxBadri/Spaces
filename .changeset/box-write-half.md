---
'@spaces/plugin-box': minor
---

Box implements the write half: `ensureFolder` creates each missing segment and, when a racing create wins the name, takes the folder Box's 409 names; `putFile` uploads in one multipart request (up to 50 MB) with the bytes' SHA-1 for Box to check, as a new version of a same-sha file under the name (case ignored, as Box compares) or as `name (2).ext`; `move` and `rename` send nothing when the item is already there or so named. The manifest still asks `root_readonly` at install; writing needs `root_readwrite`, asked for when a binding pushes.
