import "./motion-bridge";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { GearIcon, BellIcon, KeyIcon } from "@phosphor-icons/react";
import App from "../../src/App";
import "../../src/App.css";
import { Markdown } from "../../src/Markdown";
import { ChatErrorNotice } from "../../src/ChatErrorNotice";
import { SettingsTabBar } from "../../src/SettingsTabBar";
import { ConfirmModal } from "../../src/ConfirmModal";
import { Dropdown } from "../../src/Dropdown";
import { ModelSelect } from "../../src/ModelSelect";
import { RunningSchedulesButton } from "../../src/RunningSchedulesButton";
import { SlashMenu } from "../../src/SlashMenu";
import { FileMentionMenu } from "../../src/FileMentionMenu";
import { FloatingSurface } from "../../src/FloatingSurface";

function Components(): React.ReactElement {
  const [tab, setTab] = useState("general");
  const [lines, setLines] = useState(60);
  const [mounted, setMounted] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [suggestion, setSuggestion] = useState<"slash" | "file" | null>(null);
  const [scheduled, setScheduled] = useState(true);
  const [choice, setChoice] = useState("one");
  return (
    <div className="app window-focused" style={{ padding: 24, overflow: "auto", display: "block" }}>
      <section aria-label="Fixture settings tabs" style={{ position: "relative", height: 90 }}>
        <SettingsTabBar
          tabs={[
            { id: "general", label: "General", icon: GearIcon },
            { id: "notifications", label: "Notifications", icon: BellIcon },
            { id: "keys", label: "Keys", icon: KeyIcon },
          ]}
          selected={tab}
          onSelect={setTab}
          panelId="fixture-panel"
        />
      </section>
      <div id="fixture-panel">
        <button onClick={() => setLines((current) => current + 20)}>Grow fixture code</button>
        <button onClick={() => setMounted(false)}>Unmount fixture disclosures</button>
        {mounted && (
          <>
            <ChatErrorNotice
              error={{ text: "Fictional error detail. ".repeat(100) }}
              critterId="bee"
              active
            />
            <Markdown>
              {[
                "```ts",
                ...Array.from({ length: lines }, (_, i) => `const fixture${i} = ${i};`),
                "```",
              ].join("\n")}
            </Markdown>
          </>
        )}
        <RunningSchedulesButton
          schedules={
            scheduled
              ? [
                  {
                    id: "fixture-schedule",
                    prompt: "Fictional schedule",
                    intervalMs: 60000,
                    runCount: null,
                    nextRunAt: 0,
                    runsCompleted: 0,
                  },
                ]
              : []
          }
          onStop={() => setScheduled(false)}
        />
        <Dropdown
          label="Fixture choice"
          options={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
          ]}
          value={choice}
          onChange={setChoice}
        />
        <ModelSelect
          title="Fixture model"
          models={[{ id: "fixture-model", name: "Fictional model", provider: "openai" }]}
          currentModel="fixture-model"
          onSelect={() => {}}
        />
        <div style={{ position: "relative", marginTop: 320 }}>
          <button onClick={() => setSuggestion("slash")}>Open fixture plays</button>
          <button onClick={() => setSuggestion("file")}>Open fixture files</button>
          <FloatingSurface>
            {suggestion === "slash" && (
              <SlashMenu
                commands={[{ name: "fictional", description: "Fictional play", aliases: [] }]}
                activeIndex={0}
                onSelect={() => setSuggestion(null)}
                onHover={() => {}}
              />
            )}
          </FloatingSurface>
          <FloatingSurface>
            {suggestion === "file" && (
              <FileMentionMenu
                files={[{ name: "fictional.ts", path: "fictional.ts" }]}
                isRecent
                activeIndex={0}
                onSelect={() => setSuggestion(null)}
                onHover={() => {}}
              />
            )}
          </FloatingSurface>
        </div>
        <button onClick={() => setDialog(true)}>Open fixture dialog</button>
        {dialog && (
          <ConfirmModal
            title="Fictional confirmation"
            message="Nothing will execute."
            confirmLabel="Confirm"
            onConfirm={() => setDialog(false)}
            onClose={() => setDialog(false)}
          />
        )}
      </div>
    </div>
  );
}
// Logical frame inspection uses the same synchronous commit boundary as IPC.
Object.assign(window, { motionCommit: flushSync });
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  new URLSearchParams(location.search).has("components") ? <Components /> : <App />,
);
