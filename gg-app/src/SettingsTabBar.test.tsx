// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GearSixIcon, KeyIcon, SyringeIcon } from "@phosphor-icons/react";
import { SettingsTabBar, type SettingsTab } from "./SettingsTabBar";

afterEach(() => {
  cleanup();
});

type Id = "general" | "providers" | "steroids";

const TABS: SettingsTab<Id>[] = [
  { id: "general", label: "General", icon: GearSixIcon },
  { id: "providers", label: "AI Providers", icon: KeyIcon },
  { id: "steroids", label: "Steroids", icon: SyringeIcon, alert: true },
];

function Harness({ onSelect }: { onSelect?: (id: Id) => void }): React.ReactElement {
  const [selected, setSelected] = useState<Id>("general");
  return (
    <SettingsTabBar
      tabs={TABS}
      selected={selected}
      onSelect={(id) => {
        onSelect?.(id);
        setSelected(id);
      }}
      panelId="panel"
    />
  );
}

function selectedName(): string | null {
  return (
    screen
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")
      ?.getAttribute("aria-label") ?? null
  );
}

describe("SettingsTabBar", () => {
  it("is a named tab list whose tabs control the panel", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "Settings sections" })).toBeTruthy();
    for (const name of ["General", "AI Providers", "Steroids"]) {
      expect(screen.getByRole("tab", { name }).getAttribute("aria-controls")).toBe("panel");
    }
    expect(selectedName()).toBe("General");
    expect(document.querySelector(".settings-tabs-pill")?.classList.contains("is-placed")).toBe(
      true,
    );
  });

  it("supports a distinct name and tab ids when reused outside Settings", () => {
    render(
      <SettingsTabBar
        tabs={TABS}
        selected="general"
        onSelect={vi.fn()}
        panelId="checklist-panel"
        label="Checklist views"
        tabIdPrefix="checklist-tab"
      />,
    );
    expect(screen.getByRole("tablist", { name: "Checklist views" })).toBeTruthy();
    const tab = screen.getByRole("tab", { name: "General" });
    expect(tab.id).toBe("checklist-tab-general");
    expect(tab.getAttribute("aria-controls")).toBe("checklist-panel");
    expect(document.querySelector("#settings-tab-general")).toBeNull();
  });

  it("moves only on click, not on hover", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const providers = screen.getByRole("tab", { name: "AI Providers" });

    fireEvent.pointerEnter(providers);
    fireEvent.pointerMove(providers, { clientX: 40, clientY: 10 });
    expect(selectedName()).toBe("General");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(providers);
    expect(selectedName()).toBe("AI Providers");
    expect(onSelect).toHaveBeenCalledWith("providers");
  });

  it("does not re-select the tab that is already selected", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("tab", { name: "General" }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("walks the tabs with arrow keys, Home and End, keeping one Tab stop", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "General" }), { key: "ArrowRight" });
    expect(selectedName()).toBe("AI Providers");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("AI Providers");

    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(selectedName()).toBe("Steroids");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(selectedName()).toBe("General");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(selectedName()).toBe("Steroids");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(selectedName()).toBe("General");

    const stops = screen.getAllByRole("tab").filter((t) => t.tabIndex === 0);
    expect(stops.map((t) => t.getAttribute("aria-label"))).toEqual(["General"]);
  });

  it("marks a tab that needs attention", () => {
    render(<Harness />);

    expect(
      screen.getByRole("tab", { name: "Steroids" }).querySelector(".settings-tab-alert"),
    ).not.toBeNull();
    expect(document.querySelectorAll(".settings-tab-alert")).toHaveLength(1);
  });
});
