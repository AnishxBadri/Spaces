---
'@spaces/sdk': minor
---

Plugin roles: an optional `roles` array on the manifest and on the registry entry — `enrichment`, `research`, `email-calendar`, `files`, `meeting-notes`, `import`, `feeds` (`ROLES`, `PluginRole`) — naming the jobs the Plugins catalogue groups a plugin under, before and after install. A manifest without it still loads and lands under "Other". `packPlugin` copies the manifest's roles onto the entry. SDK 1.4.0.
