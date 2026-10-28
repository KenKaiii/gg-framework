import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverSkills, formatSkillsForPrompt, type Skill } from "./skills.js";
import { createSkillTool, DELEGATION_RULES, HOST_RULES } from "../tools/skill.js";
import { resolveContextLimits } from "./context-limits.js";
import { buildSystemPrompt } from "../system-prompt.js";

const skill: Skill = {
  name: "evidence-led-ui",
  description: "Use for UI work. Exclude backend-only tasks.",
  content: "Inspect before inventing.",
  source: "global",
  root: "/skills/evidence-led-ui",
};

describe("skill routing prompts", () => {
  it("requires matching skills before decisions or edits", () => {
    const prompt = formatSkillsForPrompt([skill]);

    expect(prompt).toContain("compare the user's request with every skill description");
    expect(prompt).toContain("load it with the **skill** tool first");
    expect(prompt).toContain("respect exclusions");
    // Precedence (project rules above skills) now lives once in the Work section:
    // "Precedence: user > nearest project instructions > skills > …".
    expect(prompt).toContain("evidence-led-ui");
  });

  it("places the same routing rule in the skill tool description", () => {
    const tool = createSkillTool([skill]);

    expect(tool.description).toContain(
      "When the work is in a skill's scope below, load it before writing code",
    );
    expect(tool.description).toContain("Respect exclusions");
    // Reviews write no code; without this Haiku 5.5 answered "is our data
    // safe?" with no skill in 9/10 bench runs (skills-ab-haiku55).
    expect(tool.description).toContain("before giving a review or a safety verdict");
  });

  it("fails loudly when asked for a skill that does not exist, pointing at a same-named tool", async () => {
    const tool = createSkillTool([skill]);
    const context = { signal: new AbortController().signal, toolCallId: "unknown-skill" };

    await expect(tool.execute({ skill: "enter_plan" }, context)).rejects.toThrow(
      /Skill "enter_plan" not found; nothing was loaded\..*call that tool directly/s,
    );
  });

  it("tells the main agent to check skills before coding only when the skill tool exists", async () => {
    // The tool description alone was not enough on Sonnet 5.5: 0 skill loads
    // in 132 bench runs (bench/prompt-diet), security work included.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-work-rule-"));
    try {
      const withTool = await buildSystemPrompt(cwd, [skill], false, undefined, ["read", "skill"]);
      expect(withTool).toContain("Before writing code, check the `skill` list");
      expect(withTool).toContain("Routine fixes and renames need none.");

      const withoutTool = await buildSystemPrompt(cwd, [skill], false, undefined, ["read"]);
      expect(withoutTool).not.toContain("check the `skill` list");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("counterbalances invocation pressure in both routing surfaces", () => {
    // Every pro-invocation instruction needs a brake, or topic overlap alone
    // pulls a skill in and burns context on work it would not change. The
    // brake lives here rather than in each skill's description, so it also
    // covers third-party skills written to maximize their own invocation.
    const prompt = formatSkillsForPrompt([skill]);
    expect(prompt).toContain("Match the work, not the topic");
    expect(prompt).toContain("skip skills for routine work");
    expect(prompt).toContain("never reload one");
    // A "ready to launch?" ask matches several skills at once; without a fixed
    // order the model picks one and silently skips the rest.
    expect(prompt).toContain("(durable, compliance-guard)");
    expect(prompt).toContain('a failed child is "not checked", never clean');

    const tool = createSkillTool([skill]);
    expect(tool.description).toContain("Match the work, not the topic");
    // Not "Before acting, invoke…": that opener cost a skill-only turn on a
    // plain rename 6/6 times in replay (Codex head-to-head).
    expect(tool.description).toContain("routine fixes and renames need none");
    expect(tool.description).not.toContain("Before acting");
    expect(tool.description).toContain("never reload one");
  });

  it("keeps Checklist-only skills out of every list the model sees", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-hidden-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const visible = skills
        .filter((s) => !s.hidden)
        .map((s) => s.name)
        .sort();
      expect(visible).toEqual(["compliance-guard", "durable"]);
      expect(
        skills
          .filter((s) => s.hidden)
          .map((s) => s.name)
          .sort(),
      ).toEqual(["bulletproof", "lean"]);
      const catalog = formatSkillsForPrompt(skills);
      const tool = createSkillTool(skills);
      for (const hidden of ["bulletproof", "lean"]) {
        expect(catalog).not.toContain(`**${hidden}**`);
        expect(tool.description).not.toContain(`**${hidden}**`);
      }
      // The Checklist's Security audit still loads it by name.
      const loaded = await tool.execute(
        { skill: "bulletproof" },
        { signal: new AbortController().signal, toolCallId: "checklist" },
      );
      expect(loaded).toContain('<skill_content name="bulletproof">');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("gives every bundled skill an explicit exclusion clause", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const bundled = skills.filter((candidate) => candidate.source === "bundled");
      expect(bundled.length).toBeGreaterThan(0);

      for (const candidate of bundled) {
        // A description that only says when to fire has no off switch, and the
        // model resolves ambiguity by invoking.
        expect(candidate.description, `${candidate.name} lacks an exclusion`).toMatch(
          /Do NOT use|Exclude|excluding/i,
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("tells the model the skill name is required", () => {
    const tool = createSkillTool([skill]);
    expect(tool.parameters.shape.skill.description).toContain("Required");
    expect(tool.parameters.safeParse({ args: "context only" }).success).toBe(false);
  });

  it("keeps loaded skill instructions below project and file/module rules", async () => {
    const tool = createSkillTool([skill]);
    const result = await tool.execute(
      { skill: skill.name },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(result).toContain("Skill root directory: /skills/evidence-led-ui");
    expect(result).toContain("authoritative within their stated scope");
    expect(result).toContain("Preserve higher-priority project and file/module rules");
    // Child agents see none of the conversation; the parent must hand over the
    // skill path or the delegated slice runs without the skill's rules.
    expect(result).toContain("it cannot see these instructions");
    expect(result).toContain("(/skills/evidence-led-ui)");
  });

  it("appends one shared delegation protocol instead of per-skill copies", async () => {
    const tool = createSkillTool([skill]);
    const result = await tool.execute(
      { skill: skill.name },
      { signal: new AbortController().signal, toolCallId: "delegation" },
    );
    // Goals mode lists builder/scout/researcher/checker, Code mode owl/bee/
    // auditor/skeptic: helpers are matched by role to whatever spawn_agent lists.
    expect(result).toContain(DELEGATION_RULES);
    expect(DELEGATION_RULES).toContain("use agent types your spawn_agent tool actually lists");
    expect(DELEGATION_RULES).toContain('"not checked", never clean');
    // Skills assume a user at the keyboard; a running goal says not to ask.
    expect(result).toContain(HOST_RULES);
    expect(HOST_RULES).toContain("Host rules on branches, commits and installs override the skill");
  });

  it("shows the launch-readiness rule in the live skill tool, not only the fallback prompt", () => {
    const tool = createSkillTool([skill]);
    expect(tool.description).toContain("(durable, compliance-guard)");
    expect(tool.description).toContain("report-only child");
  });

  it("never names a mode-specific helper agent as a bare agent type in a bundled skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const bundled = skills.filter((candidate) => candidate.source === "bundled");
      for (const candidate of bundled) {
        // `owl`/`bee`/`auditor`/`skeptic`/`worker` exist only in Code mode; a
        // skill that tells Goals mode to spawn one makes the spawn fail.
        expect(candidate.content, candidate.name).not.toMatch(/`(owl|bee|auditor|skeptic|worker)`/);
        // A skill that delegates defers the mechanics to the loader rather
        // than carrying its own (drifting) copy.
        if (/\bhelpers?\b/i.test(candidate.content)) {
          expect(candidate.content, candidate.name).toContain(
            "Helper types, brief contents and merge rules come with the skill loader",
          );
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every bundled skill routable and its reference paths real", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const bundled = skills.filter((candidate) => candidate.source === "bundled");
      expect(bundled.length).toBeGreaterThan(0);

      for (const candidate of bundled) {
        // Twelve-plus skills share a 16 KB catalog; a bloated description
        // crowds the others out of the routing surface.
        expect(
          Buffer.byteLength(candidate.description, "utf8"),
          `${candidate.name} description bytes`,
        ).toBeLessThanOrEqual(240); // skillDescriptionBytes cap; longer is truncated

        // The skill routes the model to references by path; a dangling path
        // silently drops the guidance it promised.
        const referenced = [...candidate.content.matchAll(/`(references\/[\w.-]+\.md)`/g)].map(
          (match) => match[1] ?? "",
        );
        for (const relative of new Set(referenced)) {
          await expect(
            fs.access(path.join(candidate.root ?? "", ...relative.split("/"))),
            `${candidate.name}: ${relative}`,
          ).resolves.toBeUndefined();
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers compliance-guard for a fresh user from bundled assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const complianceSkill = skills.find((candidate) => candidate.name === "compliance-guard");

      expect(complianceSkill?.source).toBe("bundled");
      expect(complianceSkill?.root).toContain(path.join("assets", "skills", "compliance-guard"));
      expect(complianceSkill?.content).toContain("# Compliance Guard");
      // The skill must never present itself as legal advice or certification.
      expect(complianceSkill?.content).toContain("Never certify");
      // The description says what the skill is for (legal review), not a topic
      // list: "privacy, AI features, user content" made a "where are the data
      // leaks" trace in a client app load it (omarx, Oct 2026).
      expect(complianceSkill?.description).toContain("legal side of shipping");
      expect(complianceSkill?.description).not.toContain("AI features");

      // A beginner will half-answer or ignore the intake questions, so the
      // defaults ARE the analysis. Promising defaults without stating them
      // lets the model invent a quieter reading than the user deserves.
      expect(complianceSkill?.content).toContain("Default if unanswered");
      expect(complianceSkill?.content).toContain("the cautious reading");
      // Reading code shows intent; running it shows what ships. A review that
      // asserts from grep alone misses runtime-injected tags entirely, and a
      // fix reported without verification is worse than the original finding.
      // Two-state "observed/inferred" was read as visible-in-code vs deduced,
      // not ran vs read, so a static review reported itself as verified.
      expect(complianceSkill?.content).toContain("RUNTIME");
      expect(complianceSkill?.content).toContain("DEDUCED");
      expect(complianceSkill?.content).toContain("Never relabel upward");
      expect(complianceSkill?.content).toContain("Never report a fix you did not verify");
      // Licensed activity without authorisation must stay ILLEGAL, not BLOCKER;
      // it sits with the severity ladder so even an inline gate sees it.
      expect(complianceSkill?.content).toContain("Severity rule for licensed activities");

      // The full-review workflow lives in one reference so a one-line inline
      // gate does not load it; SKILL.md must route every full review there.
      expect(complianceSkill?.content).toContain("`references/full-review.md`");
      const fullReview = await fs.readFile(
        path.join(complianceSkill?.root ?? "", "references", "full-review.md"),
        "utf8",
      );
      // Findings a novice cannot act on produce no fixes.
      expect(fullReview).toContain("never read a statute");
      // Narrative review silently drops the boring blockers; the sweep is what
      // turns "did I notice it" into "did I check it".
      expect(fullReview).toContain("coverage ledger");
      // An item never written down is an item never checked: evaluation showed
      // blockers 1 and 2 dropped while dramatic findings were reported.
      expect(fullReview).toContain("one row per numbered item");
      // Audience and product claims live in prose, not in the schema.
      expect(fullReview).toContain("Read the prose, not only the code");
      // Held-out evaluation: the code sweep reliably missed obligations that
      // arise from the product model or from two facts combined.
      expect(fullReview).toContain("second pass on the product model");
      // Held-out evaluation: the review named the first instantiation of a duty
      // it thought of (DMCA, auto-renewal) and never reached the EU equivalent
      // (DSA, withdrawal rights) for an EU-established company.
      expect(fullReview).toContain("Name every jurisdiction's version");
      // Mandatory coverage lived only in the ledger, so a findings-only output
      // format silently dropped it. Coverage must belong to the findings.
      expect(fullReview).toContain("coverage survives the output format");
      // A prohibition reported as a disclosure duty authorises the banned
      // feature; and leading with the wrong jurisdiction sends the user to the
      // wrong kind of lawyer. Both were observed in evaluation runs.
      expect(fullReview).toContain("Check for an outright ban");
      expect(fullReview).toContain("Lead with the jurisdiction");
      // A point-in-time register rots; a failing test does not.
      expect(fullReview).toContain("leave the check behind");

      // Every referenced file must exist, since the skill routes the model to them by path.
      const referenced = [...complianceSkill!.content.matchAll(/`(references\/[\w.-]+\.md)`/g)].map(
        (match) => match[1]!,
      );
      expect(referenced.length).toBeGreaterThan(0);
      const skillRoot = complianceSkill?.root ?? "";
      for (const relative of new Set(referenced)) {
        await expect(
          fs.access(path.join(skillRoot, ...relative.split("/"))),
        ).resolves.toBeUndefined();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers bulletproof for a fresh user from bundled assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const bulletproof = skills.find((candidate) => candidate.name === "bulletproof");

      expect(bulletproof?.source).toBe("bundled");
      expect(bulletproof?.root).toContain(path.join("assets", "skills", "bulletproof"));
      expect(bulletproof?.content).toContain("# Bulletproof");

      // Security work is worthless if the model declares victory: absence of
      // findings is not evidence of safety, and users read "hardened" as a
      // guarantee.
      expect(bulletproof?.content).toContain("Never certify");

      // The skill ships defensive guidance. A model that writes exploits to
      // "prove" a finding has produced attack tooling on the user's machine.
      expect(bulletproof?.content).toContain("Defensive output only");
      expect(bulletproof?.content).toContain("Hard stops");

      // Most users never ask for a security review, so the value is in the
      // inline path writing the safe version during normal feature work.
      expect(bulletproof?.content).toContain("Inline gate");
      expect(bulletproof?.content).toContain("Write the safe version the first time");

      // A grep-driven checklist produces noise; reachability is what separates
      // a finding from a pattern match.
      expect(bulletproof?.content).toContain("Reachability decides everything");

      // The intake must work for someone who cannot answer security questions.
      expect(bulletproof?.content).toContain("Default if unanswered");

      // Claiming a fix was verified when it was only read is the failure mode
      // that makes a security report actively harmful.
      expect(bulletproof?.content).toContain("RUNTIME");
      expect(bulletproof?.content).toContain("DEDUCED");

      // Silent scope gaps read as full coverage.
      expect(bulletproof?.content).toContain("what was not checked");

      // Threat data decays faster than anything else in the bundle; the model
      // must not assert a stale CVE or version as current.
      expect(bulletproof?.content).toContain("Date-check before asserting");

      // Every referenced file must exist, since the skill routes the model to them by path.
      const referenced = [...bulletproof!.content.matchAll(/`(references\/[\w.-]+\.md)`/g)].map(
        (match) => match[1]!,
      );
      expect(referenced.length).toBeGreaterThan(0);
      const skillRoot = bulletproof?.root ?? "";
      for (const relative of new Set(referenced)) {
        await expect(
          fs.access(path.join(skillRoot, ...relative.split("/"))),
        ).resolves.toBeUndefined();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets project skills override global and bundled definitions by name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-precedence-"));
    const globalSkillsDir = path.join(root, "global");
    const projectDir = path.join(root, "project");
    const projectSkillsDir = path.join(projectDir, ".gg", "skills");
    try {
      await fs.mkdir(globalSkillsDir, { recursive: true });
      await fs.mkdir(projectSkillsDir, { recursive: true });
      await fs.writeFile(
        path.join(globalSkillsDir, "evidence.md"),
        "---\nname: evidence-led-ui\ndescription: global\n---\nGlobal guidance.",
      );
      await fs.writeFile(
        path.join(projectSkillsDir, "evidence.md"),
        "---\nname: evidence-led-ui\ndescription: project\n---\nProject guidance.",
      );

      const skills = await discoverSkills({ globalSkillsDir, projectDir });
      const matching = skills.filter((candidate) => candidate.name === "evidence-led-ui");

      expect(matching).toHaveLength(1);
      expect(matching[0]?.source).toBe("project");
      expect(matching[0]?.content).toBe("Project guidance.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("skill catalog byte budgets", () => {
  it("clamps an over-long description to the budget on a codepoint boundary", () => {
    const bloated: Skill = {
      ...skill,
      description: `Use for UI work. ${"😀".repeat(600)}`, // ~2.4KB, multibyte
    };
    const prompt = formatSkillsForPrompt([bloated]);
    // Measure the description's share, not the whole prompt, so routing-text
    // growth in the header cannot mask or fake a clamp failure.
    const baseline = formatSkillsForPrompt([{ ...skill, description: "x" }]);
    const descriptionShare =
      Buffer.byteLength(prompt, "utf8") - Buffer.byteLength(baseline, "utf8");
    expect(descriptionShare).toBeLessThanOrEqual(resolveContextLimits().skillDescriptionBytes);
    expect(prompt).toContain("evidence-led-ui");
    expect(prompt).toContain("\u2026");
    expect(prompt).not.toContain("\ufffd");
  });

  it("drops overflow skills and names them in the section", () => {
    const many: Skill[] = Array.from({ length: 100 }, (_, i) => ({
      ...skill,
      name: `skill-${i}`,
      description: "x".repeat(500), // capped to 240B: 100 × ~260B > 16KB catalog budget
    }));
    const prompt = formatSkillsForPrompt(many);
    expect(prompt).toContain("Skills omitted (catalog byte budget)");
    expect(prompt).toContain("skill-99");
    // Kept prefix skills still listed.
    expect(prompt).toContain("skill-0");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(20 * 1024);
  });

  it("applies the same budget to the skill tool description", () => {
    const many: Skill[] = Array.from({ length: 100 }, (_, i) => ({
      ...skill,
      name: `skill-${i}`,
      description: "x".repeat(500),
    }));
    const tool = createSkillTool(many);
    expect(tool.description).toContain("Skills omitted (catalog byte budget)");
    expect(Buffer.byteLength(tool.description, "utf8")).toBeLessThan(20 * 1024);
  });

  it("honors raised limits", () => {
    const bloated: Skill = { ...skill, description: "x".repeat(2048) };
    const prompt = formatSkillsForPrompt(
      [bloated],
      resolveContextLimits({ skillDescriptionBytes: 4096 }),
    );
    expect(prompt).toContain("x".repeat(2048));
  });
});
