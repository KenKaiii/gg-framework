import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, pluginLogError } = vi.hoisted(() => ({
  invoke: vi.fn(),
  pluginLogError: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: pluginLogError }));

import {
  dateToLocalInputValue,
  laterTodayReminderTime,
  localDateTimeToIso,
  reminderMutationResultMessage,
  reminderPresetTimes,
  resetReminderPermissionCacheForTests,
  RoadmapReminderDeliveryHost,
  tomorrowReminderTime,
} from "./roadmap-reminders";
import type {
  NotesClient,
  NotesReminderMutationResult,
  ReminderReserveOutcome,
} from "./notes-types";

const originalTimezone = process.env.TZ;

beforeEach(() => {
  process.env.TZ = "America/New_York";
  invoke.mockReset();
  pluginLogError.mockReset();
  pluginLogError.mockResolvedValue(undefined);
  resetReminderPermissionCacheForTests();
});

afterEach(() => {
  process.env.TZ = originalTimezone;
});

function reservation(occurrenceKey = "occurrence-1"): ReminderReserveOutcome {
  return {
    status: "reserved",
    leaseToken: `lease-${occurrenceKey}`,
    expiresAt: "2026-07-28T12:00:15.000Z",
    phase: {
      id: `phase-${occurrenceKey}`,
      title: `Phase ${occurrenceKey}`,
      session: { sessionId: "session-1", sessionPath: "/session" },
    },
    reminder: {
      id: `reminder-${occurrenceKey}`,
      occurrenceKey,
      dueAt: "2026-07-28T12:00:00.000Z",
      note: `Note ${occurrenceKey}`,
    },
  };
}

function deliveryClient(reservations: ReminderReserveOutcome[]) {
  const snapshot = {
    projectKey: "/work",
    revision: 2,
    document: {
      version: 3 as const,
      reference: "",
      currentFocus: "",
      tasks: [],
      handoff: { text: "", updatedAt: null, readAt: null },
      updatedAt: "2026-07-28T12:00:00.000Z",
      legacyImportedAt: null,
      phases: [],
      references: [],
    },
  };
  return {
    reserveReminder: vi.fn(async () => reservations.shift() ?? { status: "none" as const }),
    claimReminder: vi.fn(async () => ({
      status: "ok" as const,
      snapshot,
      phase: undefined as never,
    })),
    releaseReminder: vi.fn(async () => ({ status: "released" as const })),
  } satisfies Pick<NotesClient, "reserveReminder" | "claimReminder" | "releaseReminder">;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeRetryClock() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    now: () => Date.parse("2026-07-28T12:00:00.000Z"),
    setTimeout: vi.fn((callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { callback, delayMs });
      return id;
    }),
    clearTimeout: vi.fn((handle: unknown) => {
      timers.delete(handle as number);
    }),
    pendingCount: () => timers.size,
    pendingDelays: () => [...timers.values()].map((timer) => timer.delayMs),
    async runNext() {
      const next = timers.entries().next().value as
        | [number, { callback: () => void; delayMs: number }]
        | undefined;
      if (!next) return;
      timers.delete(next[0]);
      next[1].callback();
      await flushMicrotasks();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("Roadmap reminder preset calculations", () => {
  it("rounds Later today two hours ahead to the next quarter hour", () => {
    const now = new Date(2026, 6, 28, 10, 7, 31, 400);
    expect(laterTodayReminderTime(now)).toEqual(new Date(2026, 6, 28, 12, 15, 0, 0));
    expect(reminderPresetTimes(now).laterToday).toEqual(new Date(2026, 6, 28, 12, 15, 0, 0));
  });

  it("omits Later today when the rounded instant crosses the local calendar date", () => {
    expect(laterTodayReminderTime(new Date(2026, 6, 28, 22, 1))).toBeNull();
    expect(laterTodayReminderTime(new Date(2026, 11, 31, 23, 59))).toBeNull();
  });

  it("constructs Tomorrow at local 09:00 across month, year, and DST boundaries", () => {
    expect(tomorrowReminderTime(new Date(2026, 0, 31, 20))).toEqual(new Date(2026, 1, 1, 9));
    expect(tomorrowReminderTime(new Date(2026, 11, 31, 20))).toEqual(new Date(2027, 0, 1, 9));

    const beforeSpringForward = new Date(2026, 2, 7, 20);
    const springTomorrow = tomorrowReminderTime(beforeSpringForward);
    expect(springTomorrow.getFullYear()).toBe(2026);
    expect(springTomorrow.getMonth()).toBe(2);
    expect(springTomorrow.getDate()).toBe(8);
    expect(springTomorrow.getHours()).toBe(9);

    const beforeFallBack = new Date(2026, 9, 31, 20);
    const fallTomorrow = tomorrowReminderTime(beforeFallBack);
    expect(fallTomorrow.getDate()).toBe(1);
    expect(fallTomorrow.getMonth()).toBe(10);
    expect(fallTomorrow.getHours()).toBe(9);
  });

  it("converts valid local wall time to UTC and rejects empty, past, overflow, and DST-gap values", () => {
    const now = new Date(2026, 2, 7, 12);
    const valid = localDateTimeToIso("2026-03-08T09:00", now);
    expect(valid).toBe(new Date(2026, 2, 8, 9).toISOString());
    expect(localDateTimeToIso("", now)).toBeNull();
    expect(localDateTimeToIso("2026-02-30T09:00", now)).toBeNull();
    expect(localDateTimeToIso("2026-03-07T11:59", now)).toBeNull();
    expect(localDateTimeToIso("2026-03-08T02:30", now)).toBeNull();
  });

  it("formats exact local input values without UTC drift", () => {
    expect(dateToLocalInputValue(new Date(2027, 0, 2, 9, 5))).toBe("2027-01-02T09:05");
  });
});

describe("Roadmap reminder result messaging", () => {
  it.each([
    [{ status: "committed", phaseId: "phase-1" }, "Reminder saved."],
    [{ status: "invalid-time", phaseId: "phase-1" }, "Choose a future reminder time."],
    [{ status: "missing-reminder", phaseId: "phase-1" }, "This reminder is no longer scheduled."],
    [
      {
        status: "stale-occurrence",
        phaseId: "phase-1",
        expectedOccurrenceKey: "old",
        actualOccurrenceKey: "new",
      },
      "This reminder changed in another window. Review the latest reminder.",
    ],
    [
      { status: "inactive-phase", phaseId: "phase-1" },
      "This phase is no longer eligible for reminders.",
    ],
    [
      { status: "failed", reason: "validation" },
      "Project Notes rejected the reminder change. Review it and try again.",
    ],
    [
      { status: "failed", reason: "storage" },
      "The reminder change could not be saved to Notes storage. Try again.",
    ],
    [
      { status: "failed", reason: "unavailable" },
      "Reminder storage is unavailable. Reopen the project and try again.",
    ],
  ] satisfies ReadonlyArray<readonly [NotesReminderMutationResult, string]>)(
    "maps $0 to typed recovery copy",
    (result, expected) => {
      expect(reminderMutationResultMessage(result)).toBe(expected);
    },
  );

  it("identifies cleanup as a separate stage after a successful resume", () => {
    expect(
      reminderMutationResultMessage(
        { status: "missing-reminder", phaseId: "phase-1" },
        "resume-cleanup",
      ),
    ).toBe(
      "The phase resumed, but reminder cleanup did not complete. This reminder is no longer scheduled.",
    );
  });
});

describe("RoadmapReminderDeliveryHost", () => {
  it("reruns an in-flight background drain with the latest focused route", async () => {
    const blockedReserve = deferred<ReminderReserveOutcome>();
    const client = deliveryClient([]);
    client.reserveReminder.mockImplementationOnce(() => blockedReserve.promise);
    const permission = vi.fn(async () => "granted" as const);
    const inApp = vi.fn();
    const host = new RoadmapReminderDeliveryHost(client, inApp, {
      notificationPermission: permission,
    });

    const backgroundDrain = host.drain(false);
    await flushMicrotasks();
    const focusedDrain = host.drain(true);
    blockedReserve.resolve(reservation());
    await Promise.all([backgroundDrain, focusedDrain]);

    expect(client.reserveReminder).toHaveBeenNthCalledWith(1, false);
    expect(client.reserveReminder).toHaveBeenCalledWith(true);
    expect(client.claimReminder).toHaveBeenCalledExactlyOnceWith(
      "lease-occurrence-1",
      "in-app",
      "not-required",
    );
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(permission).not.toHaveBeenCalled();
  });

  it("retries one transient reserve failure and logs it once", async () => {
    const client = deliveryClient([reservation(), { status: "none" }]);
    client.reserveReminder.mockRejectedValueOnce(new Error("reserve transport offline"));
    const clock = fakeRetryClock();
    const inApp = vi.fn();
    const log = vi.fn();
    const host = new RoadmapReminderDeliveryHost(client, inApp, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logError: log,
    });

    await host.drain(true);
    expect(clock.pendingDelays()).toEqual([1_000]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "reserve transport offline" }),
    );

    await clock.runNext();
    expect(client.claimReminder).toHaveBeenCalledTimes(1);
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("claims focused reminders before queueing in-app and never probes native permission", async () => {
    const client = deliveryClient([reservation(), { status: "none" }]);
    const order: string[] = [];
    client.claimReminder.mockImplementation(async () => {
      order.push("claimed");
      return {
        status: "ok",
        snapshot: {
          projectKey: "/work",
          revision: 2,
          document: {
            version: 3,
            reference: "",
            currentFocus: "",
            tasks: [],
            handoff: { text: "", updatedAt: null, readAt: null },
            updatedAt: "2026-07-28T12:00:00.000Z",
            legacyImportedAt: null,
            phases: [],
            references: [],
          },
        },
        phase: undefined as never,
      };
    });
    const permission = vi.fn(async () => "granted" as const);
    const native = vi.fn(async () => undefined);
    const host = new RoadmapReminderDeliveryHost(client, () => order.push("in-app"), {
      notificationPermission: permission,
      showNativeNotification: native,
    });

    await host.drain(true);
    expect(order).toEqual(["claimed", "in-app"]);
    expect(client.claimReminder).toHaveBeenCalledWith(
      "lease-occurrence-1",
      "in-app",
      "not-required",
    );
    expect(permission).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("claims background native delivery before dispatch and passes the existing sound toggle once", async () => {
    const client = deliveryClient([reservation(), { status: "none" }]);
    const order: string[] = [];
    client.claimReminder.mockImplementation(async () => {
      order.push("claimed");
      return { status: "ok", snapshot: {} as never, phase: undefined as never };
    });
    const native = vi.fn(async (soundEnabled: boolean) => {
      order.push(`native:${soundEnabled}`);
    });
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      notificationPermission: vi.fn(async () => "granted" as const),
      showNativeNotification: native,
      soundEnabled: () => true,
    });

    await host.drain(false);
    expect(order).toEqual(["claimed", "native:true"]);
    expect(client.claimReminder).toHaveBeenCalledWith("lease-occurrence-1", "native", "granted");
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("keeps mute from suppressing native display", async () => {
    const client = deliveryClient([reservation(), { status: "none" }]);
    const native = vi.fn(async () => undefined);
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      notificationPermission: vi.fn(async () => "granted" as const),
      showNativeNotification: native,
      soundEnabled: () => false,
    });
    await host.drain(false);
    expect(native).toHaveBeenCalledWith(false);
  });

  it("routes a denied production command result to fallback without native dispatch", async () => {
    invoke.mockResolvedValueOnce("denied");
    const client = deliveryClient([reservation(), { status: "none" }]);
    const native = vi.fn(async () => undefined);
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      showNativeNotification: native,
    });

    await host.drain(false);

    expect(invoke).toHaveBeenCalledExactlyOnceWith("roadmap_reminder_notification_permission");
    expect(client.claimReminder).toHaveBeenCalledExactlyOnceWith(
      "lease-occurrence-1",
      "in-app-fallback",
      "denied",
    );
    expect(native).not.toHaveBeenCalled();
  });

  it("shares one in-flight permission request and claims denied input as in-app fallback", async () => {
    const firstClient = deliveryClient([reservation("one"), { status: "none" }]);
    const secondClient = deliveryClient([reservation("two"), { status: "none" }]);
    const permission = vi.fn(async () => "denied" as const);
    const native = vi.fn(async () => undefined);
    const dependencies = {
      notificationPermission: permission,
      showNativeNotification: native,
    };
    const first = new RoadmapReminderDeliveryHost(firstClient, vi.fn(), dependencies);
    const second = new RoadmapReminderDeliveryHost(secondClient, vi.fn(), dependencies);

    await Promise.all([first.drain(false), second.drain(false)]);
    expect(permission).toHaveBeenCalledTimes(1);
    expect(firstClient.claimReminder).toHaveBeenCalledWith(
      "lease-one",
      "in-app-fallback",
      "denied",
    );
    expect(secondClient.claimReminder).toHaveBeenCalledWith(
      "lease-two",
      "in-app-fallback",
      "denied",
    );
    expect(native).not.toHaveBeenCalled();
  });

  it("rechecks permission after an in-flight request settles so OS setting drift is visible", async () => {
    const client = deliveryClient([
      reservation("enabled"),
      reservation("disabled"),
      { status: "none" },
    ]);
    const permission = vi
      .fn<() => Promise<"granted" | "denied">>()
      .mockResolvedValueOnce("granted")
      .mockResolvedValueOnce("denied");
    const native = vi.fn(async () => undefined);
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      notificationPermission: permission,
      showNativeNotification: native,
    });

    await host.drain(false);
    expect(permission).toHaveBeenCalledTimes(2);
    expect(client.claimReminder).toHaveBeenNthCalledWith(1, "lease-enabled", "native", "granted");
    expect(client.claimReminder).toHaveBeenNthCalledWith(
      2,
      "lease-disabled",
      "in-app-fallback",
      "denied",
    );
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("records an unverifiable platform as unavailable and never dispatches native", async () => {
    const client = deliveryClient([reservation(), { status: "none" }]);
    const native = vi.fn(async () => undefined);
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      notificationPermission: vi.fn(async () => "unavailable" as const),
      showNativeNotification: native,
    });

    await host.drain(false);
    expect(client.claimReminder).toHaveBeenCalledWith(
      "lease-occurrence-1",
      "in-app-fallback",
      "unavailable",
    );
    expect(native).not.toHaveBeenCalled();
  });

  it("contains a rejected plugin log write while scheduling a transport retry", async () => {
    const client = deliveryClient([]);
    client.reserveReminder.mockRejectedValueOnce(new Error("reserve transport offline"));
    pluginLogError.mockRejectedValueOnce(new Error("Tauri logging unavailable"));
    const clock = fakeRetryClock();
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    await host.drain(true);
    await flushMicrotasks();

    expect(pluginLogError).toHaveBeenCalledExactlyOnceWith(
      "roadmap reminder delivery failed: Error: reserve transport offline",
    );
    expect(clock.pendingDelays()).toEqual([1_000]);
    host.dispose();
  });

  it("releases and retries one transient claim failure without duplicate delivery", async () => {
    const client = deliveryClient([reservation(), reservation(), { status: "none" }]);
    client.claimReminder.mockRejectedValueOnce(new Error("claim transport offline"));
    const clock = fakeRetryClock();
    const inApp = vi.fn();
    const log = vi.fn();
    const host = new RoadmapReminderDeliveryHost(client, inApp, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logError: log,
    });

    await host.drain(true);
    expect(client.releaseReminder).toHaveBeenCalledExactlyOnceWith("lease-occurrence-1");
    expect(inApp).not.toHaveBeenCalled();
    expect(clock.pendingDelays()).toEqual([1_000]);

    await clock.runNext();
    expect(client.claimReminder).toHaveBeenCalledTimes(2);
    expect(client.releaseReminder).toHaveBeenCalledTimes(1);
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "claim transport offline" }),
    );
  });

  it("cancels retry timers and queued reruns when disposed", async () => {
    const retryClient = deliveryClient([]);
    retryClient.reserveReminder.mockRejectedValueOnce(new Error("reserve transport offline"));
    const clock = fakeRetryClock();
    const retryHost = new RoadmapReminderDeliveryHost(retryClient, vi.fn(), {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logError: vi.fn(),
    });

    await retryHost.drain(true);
    expect(clock.pendingCount()).toBe(1);
    retryHost.dispose();
    expect(clock.pendingCount()).toBe(0);
    await clock.runNext();
    expect(retryClient.reserveReminder).toHaveBeenCalledTimes(1);

    const blockedReserve = deferred<ReminderReserveOutcome>();
    const rerunClient = deliveryClient([]);
    rerunClient.reserveReminder.mockImplementationOnce(() => blockedReserve.promise);
    const rerunHost = new RoadmapReminderDeliveryHost(rerunClient, vi.fn());
    const firstDrain = rerunHost.drain(false);
    await flushMicrotasks();
    const queuedDrain = rerunHost.drain(true);
    rerunHost.dispose();
    blockedReserve.resolve({ status: "none" });
    await Promise.all([firstDrain, queuedDrain]);
    expect(rerunClient.reserveReminder).toHaveBeenCalledTimes(1);
  });

  it("logs native dispatch failure after claim without replaying the occurrence", async () => {
    const client = deliveryClient([reservation(), { status: "already-delivered" }]);
    const log = vi.fn();
    const host = new RoadmapReminderDeliveryHost(client, vi.fn(), {
      notificationPermission: vi.fn(async () => "granted" as const),
      showNativeNotification: vi.fn(async () => {
        throw new Error("native unavailable");
      }),
      logError: log,
    });
    await host.drain(false);
    expect(client.claimReminder).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: "native unavailable" }));
  });

  it("queues multiple focused claims in due order instead of stacking delivery work", async () => {
    const client = deliveryClient([reservation("one"), reservation("two"), { status: "none" }]);
    const queue: string[] = [];
    const host = new RoadmapReminderDeliveryHost(client, (delivery) => {
      queue.push(delivery.reminder.occurrenceKey);
    });
    await host.drain(true);
    expect(queue).toEqual(["one", "two"]);
    expect(client.claimReminder).toHaveBeenCalledTimes(2);
  });
});
