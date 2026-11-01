import { describe, expect, it } from "vitest";
import {
  UPDATE_CHECK_LEASE_MS,
  claimUpdateCheck,
  recordUpdateCheck,
  versionFromStorageEvent,
} from "./update-schedule";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("claimUpdateCheck", () => {
  it("lets one of N windows check per lease; the rest skip", () => {
    const storage = memoryStorage();
    const decisions = Array.from({ length: 4 }, () => claimUpdateCheck(storage, 1000).kind);
    expect(decisions).toEqual(["check", "skip", "skip", "skip"]);
  });

  it("re-checks once the lease expires", () => {
    const storage = memoryStorage();
    claimUpdateCheck(storage, 0);
    recordUpdateCheck(storage, 0, null);
    expect(claimUpdateCheck(storage, UPDATE_CHECK_LEASE_MS - 1).kind).toBe("skip");
    expect(claimUpdateCheck(storage, UPDATE_CHECK_LEASE_MS).kind).toBe("check");
  });

  it("tells other windows to fetch their own handle when an update was found", () => {
    const storage = memoryStorage();
    claimUpdateCheck(storage, 0);
    recordUpdateCheck(storage, 0, "2.0.0");
    expect(claimUpdateCheck(storage, 10)).toEqual({ kind: "fetch", version: "2.0.0" });
  });

  it("checks without storage and ignores corrupt or future records", () => {
    expect(claimUpdateCheck(null, 0).kind).toBe("check");
    const storage = memoryStorage();
    storage.setItem("gg-update-check", "{nope");
    expect(claimUpdateCheck(storage, 0).kind).toBe("check");
    recordUpdateCheck(storage, 5_000, null);
    expect(claimUpdateCheck(storage, 0).kind).toBe("check");
  });

  it("reads versions from storage events", () => {
    expect(versionFromStorageEvent("gg-update-check", '{"at":1,"version":"3.0.0"}')).toBe("3.0.0");
    expect(versionFromStorageEvent("other", '{"version":"3.0.0"}')).toBeNull();
    expect(versionFromStorageEvent("gg-update-check", '{"at":1,"version":null}')).toBeNull();
  });
});
