import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { releaseText, WhatsNewWindow } from "./WhatsNewWindow";

describe("releaseText", () => {
  it("renders explicit and known specifics as themed inline highlights", () => {
    const html = renderToStaticMarkup(
      <>{releaseText("Turn on `Autopilot` for GPT-5.6 and save 90 MB.")}</>,
    );

    expect(html).not.toContain("`");
    expect(html.match(/class="whatsnew-highlight"/g)).toHaveLength(3);
    expect(html).toContain(">Autopilot</strong>");
    expect(html).toContain(">GPT-5.6</strong>");
    expect(html).toContain(">90 MB</strong>");
  });

  it("features the latest release before separating the update history", () => {
    const html = renderToStaticMarkup(<WhatsNewWindow />);
    const latestIndex = html.indexOf("whatsnew-section latest");
    const historyIndex = html.indexOf("Previous updates");

    expect(latestIndex).toBeGreaterThan(-1);
    expect(html.match(/whatsnew-section latest/g)).toHaveLength(1);
    expect(html).toContain('class="badge"');
    expect(historyIndex).toBeGreaterThan(latestIndex);
  });
});
