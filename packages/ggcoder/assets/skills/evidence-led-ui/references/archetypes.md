# Archetype Guidance

## How to choose

Choose the archetype by the screen’s job, not the company category. A developer company’s billing console is application UI; its API reference is documentation; its launch page is marketing/brand. Hybrid screens may borrow one secondary archetype, but one must lead.

All coverage and counts come from extraction version 1 of [`VoltAgent/awesome-design-md`](https://github.com/VoltAgent/awesome-design-md) at commit `664b3e78fd1a298ba11973822da988483256d4b4`. Each section names two aligned references and one contrast by upstream slug: the source is `https://github.com/VoltAgent/awesome-design-md/blob/664b3e78fd1a298ba11973822da988483256d4b4/design-md/<slug>/DESIGN.md`. References are observational analyses, not templates to copy.

Every archetype also follows `craft-rulings.md`: no emoji UI, one coherent icon family, uniform key lines, reuse of local primitives, purposeful non-abrupt feedback without generic hover lift, intentional typography, measured contrast, consistent flow, and no generated em dashes in UI copy. Every implemented surface must also pass the applicable `production-contract.md` checks; archetype evidence never overrides semantics, accessibility, resilience, performance, platform, or trust requirements.

## Marketing and brand

**Coverage:** **29/74 documents**. Dark **17/29**, mixed **7/29**, light **5/29**; motion mentioned in **19/29**. This is the largest and most technology-heavy group, so avoid exporting its conventions to product screens.

**Design read:** Establish one claim, one audience, and one conversion. Let content cadence determine whether the composition is cinematic, editorial, demonstrative, or direct.

**Direction:** Use a strong typographic or media hierarchy, variable section rhythm, and one subject-specific signature. Motion may stage narrative transitions, but it must not delay comprehension or interaction. Keep conversion hierarchy unmistakable.

**Aligned evidence:** `apple`, `sanity`. **Useful contrast:** `figma`.

**Reject:** A centered gradient headline, generic dashboard mockup, three equal feature cards, and floating glass shapes that could advertise any SaaS.

## Application UI

**Coverage:** **7/74 documents**. Focus mentioned in **7/7**, disabled state in **6/7**, motion in **5/7**, keyboard language in only **1/7**. The sample is small and still based on public-site analyses.

**Design read:** Name the repeated task, frequency, consequence of error, user expertise, and information that must remain visible while acting.

**Direction:** Optimize stable navigation, predictable control placement, concise hierarchy, and fast state recognition. Use density appropriate to task frequency. Keep decorative layers behind the work surface. Add keyboard and loading/empty behavior even though the corpus documents it poorly.

**Aligned evidence:** `linear.app`, `superhuman`. **Useful contrast:** `intercom`.

**Reject:** Marketing-scale headings, scroll-led reveals, and oversized cards that turn repeated work into a tour.

## Dashboards and data-dense tools

**Coverage:** **5/74 documents**. Dense language in **4/5**, focus in **5/5**, keyboard in **3/5**, error in **5/5**. Theme is dark **3/5**, light **1/5**, mixed **1/5**; the denominator is too small to prescribe a theme.

**Design read:** Identify the decision the dashboard supports, update frequency, comparison axis, alert severity, and the smallest unit users scan repeatedly.

**Direction:** Build a scan path before styling cards. Prefer alignment, separators, restrained surface steps, and semantic status encoding. Preserve row/column context, expose units, support keyboard navigation, and make filters visibly affect results. Charts should answer named questions rather than fill grid slots.

**Aligned evidence:** `airtable`, `sentry`. **Useful contrast:** `miro`.

**Reject:** Random metric tiles, equal visual weight for all data, unlabeled sparklines, and decorative gradients that compete with status colors.

## Commerce and marketplaces

**Coverage:** **12/74 documents**. Theme is light **5/12**, dark **4/12**, mixed **3/12**; subtle-shadow policy appears in **8/12**; loading in **3/12** and empty state in **1/12**. Coverage spans retail, fintech, travel, and payments, so transaction risk varies widely.

**Design read:** Resolve discovery versus purchase, inventory variability, trust burden, comparison behavior, and the role of imagery.

**Direction:** Make product evidence, price, availability, trust, and primary transaction action legible in that order. Let imagery dictate card geometry when imagery is decision-critical. Use material softness only when it supports tactility or approachability. Design unavailable, loading, saved, and failure states explicitly.

**Aligned evidence:** `airbnb`, `nike`. **Useful contrast:** `binance`.

**Reject:** Generic product cards with fake ratings, identical crops, hidden fees, or a brand accent applied equally to navigation, price, badges, and purchase action.

## Editorial and content

**Coverage:** **5/74 documents**. Asymmetry appears in **3/5**, full-bleed composition in **4/5**, motion in **1/5**, sharp-corner language in **3/5**. This is a small sample dominated by technology and media.

**Design read:** Name the reading mode, expected session length, content hierarchy, recirculation goal, and whether imagery or text carries authority.

**Direction:** Design reading rhythm through measure, leading, headline contrast, captions, metadata, and deliberate interruption. Use asymmetry when it clarifies editorial priority. Keep controls quiet and persistent enough to support progress, saving, or navigation.

**Aligned evidence:** `wired`, `theverge`. **Useful contrast:** `spotify`.

**Reject:** SaaS feature cards, pill labels on every taxonomy term, animated ornaments beside long-form copy, and uniform modules that erase editorial priority.

## Documentation and developer tools

**Coverage:** **16/74 documents**. Dark **11/16**, mixed **4/16**, light **1/16**; sidebar language **8/16**; focus **13/16**; keyboard language **0/16**. The category is well represented but heavily biased toward developer marketing surfaces.

**Design read:** Determine whether the user is learning, looking up, debugging, or copying; identify versioning, code-language, and navigation depth.

**Direction:** Prioritize information scent, stable navigation, readable prose measure, copyable code, visible current context, and search. A technical accent or monospace register can support meaning, but code should not become decoration. Add keyboard access and command discoverability despite the corpus gap.

**Aligned evidence:** `mintlify`, `vercel`. **Useful contrast:** `hashicorp`.

**Reject:** Terminal theater, fake logs, neon syntax everywhere, hidden navigation, and dark mode chosen solely to look “developer.”

## Mobile and native surfaces

**Coverage:** **0/74 documents**. The corpus cannot support a quantitative mobile/native house style.

**Design read:** Resolve platform, input mode, reach zones, navigation convention, offline behavior, permissions, interruption, and whether the surface is phone, tablet, watch, or desktop native.

**Direction:** Preserve the project’s platform conventions and native controls. Use official platform guidance and rendered/device testing as primary evidence. Borrow only content hierarchy and brand semantics from the closest corpus archetype. Plan touch, keyboard, pointer, dynamic type, safe areas, orientation, and reduced motion as applicable.

**Aligned evidence:** none in this corpus. **Closest structural references:** `airbnb`, `superhuman`. **Useful contrast:** `apple` marketing analysis, which must not be mistaken for native UI guidance.

**Reject:** Shrinking a desktop web composition into a phone viewport or inventing gestures without discoverable alternatives.

## Cross-archetype rule

Select **two aligned references and one contrast**, then write why each is relevant to this exact screen. If the same palette, radius, font stack, composition, or motion policy survives unchanged across unrelated briefs, the thesis is under-specified.
