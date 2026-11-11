---
"@kleio/ai": patch
---

`undici` 7.29.1 → 7.30.2, for the advisories fixed in 7.30.1. The ones the provider transport (`createProviderFetch`) can hit are a crash when an HTTPS endpoint renegotiates TLS 1.2 to a certificate for another host (GHSA-qrxm-fqhp-jwvm) and a crash when a response has more than five content codings (GHSA-xjj6-f33q-929c). The workspace override for `undici@7` moves to ^7.30.2 to match.
