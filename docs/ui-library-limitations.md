# UI-library integration: engineering limitations

Snapshot: 22 September 2026. Base revision: `ec29187fabda3767663e0ff815423307ed3420a6` plus working-tree changes.

**Engineering guidance, not legal advice. This is not a whole-product compliance review.**

## Scope

Public Bklit/Kokonut component discovery, supporting shadcn source, and Motion API guidance. No customer data or paid assets are needed for this feature. Bklit Studio and Motion+ assets are excluded.

## Feature-specific register

| ID | Concern | Evidence | Control / remaining limitation |
| --- | --- | --- | --- |
| UI-1 | Public source is not proof of production rights | CODE: registry attribution and dependency reporting | Preserve source notices; record hosted payload hashes separately from inventory revisions. Verify the applicable upstream license before distribution. |
| UI-2 | Dependency licenses can differ from component licenses | CODE: adoption flags Iconists | Nonstandard/unknown dependency terms need independent review. This feature does not implement a full transitive license scanner or certify rights. |
| UI-3 | Paid-library content | CODE: exact public registry URL allowlist | No Studio/Motion+ asset endpoints or installers are supported. Public registry contents still require review. |

## Implemented controls

The adoption plan reports provenance, dependencies, styling requirements and attribution. It preserves source text except explicit import relocation and separately recorded hash-gated compatibility patches. It never runs registry install commands or lifecycle scripts.

## Before production distribution

Review the current upstream and dependency license texts, preserve required notices, and obtain legal advice for unclear/nonstandard terms. Hosted payloads can change independently of pinned inventory revisions; equivalence is not claimed. No whole-product privacy, consumer-contract, accessibility or jurisdiction review was performed here.
