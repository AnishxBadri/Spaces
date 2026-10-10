---
'@spaces/plugin-apollo': minor
---

Apollo now reads every field D76 lists. For a company it answers the funding stage, total raised, headcount, revenue, industry, keywords, tech stack, social and profile links, phone, HQ address, ticker and logo. For a person it answers the description (from the headline, only when blank), the company by name and domain, seniority, department, GitHub, Facebook and the photo. The phone is a new `phone` setting, off by default, that costs extra credits. An email is claimed only when Apollo marks it verified. The latest round and a change of company or title are keyed events, so a re-run writes nothing new.
