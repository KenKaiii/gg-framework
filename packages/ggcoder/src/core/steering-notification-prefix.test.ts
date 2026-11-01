import { describe, expect, it } from "vitest";
import {
  LEGACY_NOTIFICATION_PREFIX,
  NOTIFICATION_PREFIX,
  buildNotificationSteeringText,
  isNotificationText,
} from "./steering.js";

describe("notification prefix", () => {
  it("is shorter than the earlier wording and still says it is not an instruction", () => {
    expect(NOTIFICATION_PREFIX.length).toBeLessThan(LEGACY_NOTIFICATION_PREFIX.length);
    expect(NOTIFICATION_PREFIX).toContain("not a new instruction");
  });

  it("recognises both the current and the saved-transcript wording", () => {
    expect(isNotificationText(buildNotificationSteeringText(["x"]))).toBe(true);
    expect(isNotificationText(`${LEGACY_NOTIFICATION_PREFIX}- x`)).toBe(true);
    expect(isNotificationText("hello")).toBe(false);
  });
});
