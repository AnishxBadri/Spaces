---
'@spaces/sdk': minor
---

The enrichment vocabulary: `ENRICHMENT_VOCABULARY` (also `@spaces/sdk/vocabulary`) names every key a source may answer, each with its record kind, value type and whether it is a changing figure. A source answers through the new `Facts.answer({ entityId, answers, receiptId, asOf? })` in those keys, never in attribute slugs; a key outside the vocabulary or a value of the wrong shape fails the call permanently, naming the key. An action's input carries `keys`, what the host's enrichment run still wants from the source. The testing kit's `FactsTest` answers too. `Facts.fill` stays for writers that are not enrichment sources. SDK 1.3.0.
