// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { describeSecurityBlock, SecurityNotice } from "./SecurityNotice";

afterEach(cleanup);

describe("security chat row", () => {
  it("says what was blocked and why, in plain words", () => {
    expect(describeSecurityBlock("malicious-package", "npm install chalk@5.6.1")).toBe(
      "Blocked for safety: known malware \u00b7 npm install chalk@5.6.1",
    );
    expect(describeSecurityBlock("malicious-package", "npm i a", 3)).toBe(
      "Blocked for safety: known malware \u00b7 npm i a \u00d73",
    );
    expect(describeSecurityBlock("not-a-rule", "")).toBe("Blocked for safety: safety rule");
    expect(describeSecurityBlock("dns-exfil", "ping x")).toBe(
      "Blocked for safety: would leak data \u00b7 ping x",
    );
    expect(
      describeSecurityBlock(
        "installed-malware",
        "debug@4.4.2 (MAL-2025-46974) in package-lock.json",
      ),
    ).toBe(
      "Infected package in this project, replacing it \u00b7 debug@4.4.2 (MAL-2025-46974) in package-lock.json",
    );
    expect(describeSecurityBlock("brand-new-rule", "")).toBe("Blocked for safety: safety rule");
  });

  it("renders the wording as a note, not a prompt", () => {
    render(<SecurityNotice rule="malicious-package" target="npm install chalk@5.6.1" />);
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(
      "Blocked for safety: known malware \u00b7 npm install chalk@5.6.1",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
