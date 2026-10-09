---
'@spaces/sdk': minor
---

Two picture keys in the enrichment vocabulary: `company.logo` and `person.photo`, of the new value type `image` (an http(s) URL). A source answers the URL; the host fetches it once, stores it and sets the record's picture only when it is empty. An `image` key is never linked to an attribute.
