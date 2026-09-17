import { describe, expect, it } from "vitest";
import {
  PROJECT_ACCENTS,
  PROJECT_COLOUR_NAMES,
  isProjectColourChoice,
  projectAccent,
  resolveProjectAccent,
} from "./projectAccent";

describe("project accents", () => {
  it("keeps the original final-folder FNV-1a automatic accent", () => {
    expect(projectAccent("/work/app")).toBe("#36c489");
    expect(projectAccent("/different/APP")).toBe(projectAccent("/work/app"));
    expect(projectAccent("C:\\work\\app")).toBe(projectAccent("/work/app"));
    expect(resolveProjectAccent("/work/app", "Automatic")).toBe(projectAccent("/work/app"));
  });

  it("resolves every named palette colour and None without changing the palette", () => {
    PROJECT_COLOUR_NAMES.forEach((name, index) => {
      expect(resolveProjectAccent("/work/app", name)).toBe(PROJECT_ACCENTS[index]);
      expect(isProjectColourChoice(name)).toBe(true);
    });
    expect(resolveProjectAccent("/work/app", "None")).toBeNull();
    for (const cwd of [undefined, null, "", "/"]) {
      expect(projectAccent(cwd)).toBeNull();
      expect(resolveProjectAccent(cwd, "Blue")).toBeNull();
    }
  });

  it("rejects persisted CSS and unknown choices", () => {
    for (const value of ["#4d9dff", "red", "url(secret)", {}, 1, null, "automatic"]) {
      expect(isProjectColourChoice(value)).toBe(false);
    }
    expect(isProjectColourChoice("Automatic")).toBe(true);
    expect(isProjectColourChoice("None")).toBe(true);
  });
});
