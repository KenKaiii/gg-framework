# Corpus Methodology

## Scope

This skill analyzes the MIT-licensed public `DESIGN.md` snapshot from [`VoltAgent/awesome-design-md`](https://github.com/VoltAgent/awesome-design-md) at commit `664b3e78fd1a298ba11973822da988483256d4b4` (retrieved 2026-07-13).

The archive contains **74/74 discovered `design-md/*/DESIGN.md` files**. The approved planning estimate said 75, while the upstream README badge at the pinned commit says 73 and omits the present `slack` file. Archive-tree enumeration is the authoritative count for this snapshot.

These files are independent analyses of public websites. They are not official brand design systems, and a frequency in this corpus is not a universal design rule.

## Deterministic extraction

The counts were produced on 13 July 2026 by a standard-library Node analyzer that verified each source's SHA-256, parsed headings and frontmatter, and wrote deterministic observations. The raw corpus, the analyzer and its generated data are not bundled (removed 22 October 2026 to keep the package small); the derived counts below and in `references/observed-patterns.md` are the retained record. Re-deriving a count means reading the sources at the pinned upstream commit.

At extraction version 1, **64/74 documents** use frontmatter plus prose and **10/74** use numbered prose without frontmatter. All **74/74** are parsed; unsupported files would be retained with an explicit reason rather than silently dropped. Counts come from extraction version 1 at source commit `664b3e…`.

## What the parser measures

- **Color:** hexadecimal values, nearby semantic role language, accent count, surface ladder, HSL distributions, hue bins, and semantic-state mentions. It never averages colors into a recommended hex value.
- **Typography:** family strings, display/body/utility/code role language, font sizes, weights, tracking, line-height, and explicit line-length guidance.
- **Layout:** declared spacing scales, inferred 4/5/8px bases only when scale evidence has at least 60% coverage, section spacing, max-width declarations, density language, and named composition patterns.
- **Shape and material:** radius values tied to radius language, pill/sharp-corner mentions, borders, dividers, shadows, blur, gradients, imagery, and surface-separation language.
- **Components and states:** buttons, inputs, cards, navigation, tables, CTA language, hover, focus, press/active, disabled, loading, empty, error, and semantic color states.
- **Motion and access:** motion terms, durations, easing, reduced-motion language, accessibility, focus, keyboard, and contrast language.
- **Rules and motifs:** explicit do/do-not lines and sentences that identify a signature, motif, or defining characteristic.

## Statistics and missing data

Numeric outputs use min, first quartile, median, third quartile, max, and an explicit sample count. Frequencies always store `{ count, denominator }`. Unknown values remain `null`, `false`, or empty arrays and do not enter numeric sample counts.

Hue is reported in 30-degree bins because linear averaging is invalid across the 0°/360° boundary. Color recommendations must use semantic role and brief fit, never a corpus-average color.

Co-occurrences mean two terms or policies appeared in the same analysis; they do not prove a causal design relationship. Representative slugs are the most extraction-complete records, not quality rankings. Contrasts are selected from a non-dominant inferred theme.

## Categories and archetypes

The manifest preserves the ten upstream README groupings, including the two-file Retro Web section, and marks the present-but-uncatalogued `slack` file separately instead of inventing an upstream category. The analyzer separately maps documents into six usable product archetypes plus a zero-coverage mobile/native category:

- marketing/brand;
- application UI;
- dashboards/data-dense tools;
- commerce/marketplaces;
- editorial/content;
- documentation/developer tools;
- mobile/native (**0 documents**).

This mapping is analytical judgment, recorded in the (unbundled) analyzer; it is not supplied by upstream. A source appears in exactly one analytical archetype so denominators remain auditable.

## Known limitations

- The corpus overrepresents technology marketing and developer products: marketing/brand has **29/74 documents**, while editorial has **5/74** and mobile/native has **0/74** (commit `664b3e…`, extraction v1).
- Mention detection records what an analysis discusses, including prohibitions. Policy classifiers distinguish direct “no shadows/gradients” language from subtle treatment where possible, but nuanced prose still needs human review.
- Font-family counts include fallbacks and substitutes; they are evidence of documented vocabulary, not the number of fonts loaded by a website.
- Radius vocabularies can include component exceptions. Use the component rule and local project token set before the corpus-wide distribution.
- The files describe selected public surfaces, often marketing pages, not every state in the underlying product.
- No screenshots, brand assets, paid files, private requests, fonts, website media, or Refero data are included.

## Product-owner rulings and production standards versus corpus evidence

`references/craft-rulings.md` contains Ken's binding product defaults for emoji, icons, alignment, reuse, motion, UI punctuation, typography, contrast, consistency, and flow. `references/production-contract.md` contains the separate pass/fail implementation floor for semantics, accessibility, forms, resilience, performance, platform behavior, tokens, trust, and verification. Neither document presents its requirements as corpus frequencies. `references/provenance.md` records the current standards and implementation sources that support them.

## How to use the evidence

Select the matching archetype first. Read corpus-wide findings only as context, inspect two aligned sources and one useful contrast, then test the choice against the actual product brief and existing project. If the local product contradicts the corpus, the product wins.
