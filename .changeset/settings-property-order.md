---
'@spaces/sdk': minor
---

The settings JSON Schema the build emits — the plugin's and a watch job's — carries `propertyOrder`, the properties in declaration order. The host stores the manifest as jsonb, which sorts object keys, so the settings form now draws its fields in the order the plugin declared them; a manifest built before this falls back to the stored order.
