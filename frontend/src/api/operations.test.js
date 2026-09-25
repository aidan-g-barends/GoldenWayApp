import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Driver / Inspector / Admin-alerts API layer (api/operations.js).
 * Supabase is mocked, so nothing touches the network — these pin down the
 * contract between the screens and the database: which RPC name is called,
 * with which arguments, how rows are mapped, and how errors are translated.
 * The real-database checks live in operations.live.test.js.
 */

const h = vi.hoisted(() => ({
  rpc: null,
  from: null,
  getUser: null,
  getSession: null,
}));

vi.mock("../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...a) => h.rpc(...a),
    from: (...a) => h.from(...a),
    auth: {
      getUser: (...a) => h.getUser(...a),
      getSession: (...a) => h.getSession(...a),
    },
  },
}));

import {
  deactivateMyAccount,
  fetchAllOpenRuns,
  fetchMyRecentInspections,
  fetchMyRuns,
  logInspectionOutcome,
  lookupCardForInspection,
  reportRunStatus,
  startRun,
  withdrawAlert,
} from "./operations.js";
import { ApiError } from "./client.js";

/** Chainable, awaitable stand-in for a supabase-js query builder. */
function queryBuilder(result) {
  const ops = [];
  const b = { ops };
  for (const m of ["select", "order", "limit", "eq", "is", "update"]) {
    b[m] = vi.fn((...args) => {
      ops.push([m, ...args]);
      return b;
    });
  }
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

beforeEach(() => {
  h.rpc = vi.fn();
  h.from = vi.fn();
  h.getUser = vi.fn();
  h.getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: "driver-uid" } } } });
});

describe("error translation (toApiError)", () => {
  it("maps Postgres 42501 to a friendly 403", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } });
    const err = await startRun("KHA-CPT", "GW-1001").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("You don't have permission for that action.");
  });

  it("maps a bare FORBIDDEN exception to 403", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "FORBIDDEN" } });
    const err = await reportRunStatus(1, "DELAYED", 10).catch((e) => e);
    expect(err.status).toBe(403);
  });

  it("maps 'already claimed' style conflicts to 409 and keeps the message", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "ticket already claimed" } });
    const err = await deactivateMyAccount().catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toBe("ticket already claimed");
  });

  it("passes validation messages through as a 400", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "note: keep it under 300 characters" } });
    const err = await logInspectionOutcome("GW1", "VALID", "x").catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toBe("note: keep it under 300 characters");
  });

  it("falls back to 'Request failed' when the error has no message", async () => {
    h.rpc.mockResolvedValue({ data: null, error: {} });
    const err = await startRun("KHA-CPT", "GW-1001").catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Request failed");
  });
});

describe("driver: startRun / reportRunStatus", () => {
  it("startRun calls start_run with the right arguments", async () => {
    h.rpc.mockResolvedValue({ data: { id: 5 }, error: null });
    const run = await startRun("KHA-CPT", "GW-1001", "INBOUND", "Pre-trip OK");
    expect(h.rpc).toHaveBeenCalledWith("start_run", {
      p_route_code: "KHA-CPT",
      p_bus_id: "GW-1001",
      p_direction: "INBOUND",
      p_note: "Pre-trip OK",
    });
    expect(run).toEqual({ id: 5 });
  });

  it("startRun defaults direction to OUTBOUND and note to null", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    await startRun("KHA-CPT", "GW-1001");
    expect(h.rpc).toHaveBeenCalledWith("start_run", {
      p_route_code: "KHA-CPT",
      p_bus_id: "GW-1001",
      p_direction: "OUTBOUND",
      p_note: null,
    });
  });

  it("startRun treats an empty direction as OUTBOUND", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    await startRun("KHA-CPT", "GW-1001", "");
    expect(h.rpc.mock.calls[0][1].p_direction).toBe("OUTBOUND");
  });

  it("reportRunStatus calls report_run_status with delay and note", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    await reportRunStatus(12, "DELAYED", 20, "Traffic on N2");
    expect(h.rpc).toHaveBeenCalledWith("report_run_status", {
      p_run_id: 12,
      p_status: "DELAYED",
      p_delay_minutes: 20,
      p_note: "Traffic on N2",
    });
  });

  it("reportRunStatus defaults to no delay and no note", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    await reportRunStatus(12, "COMPLETED");
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_delay_minutes: 0, p_note: null });
  });
});

describe("driver: fetchMyRuns", () => {
  it("maps snake_case rows to the camelCase the screens use", async () => {
    const b = queryBuilder({
      data: [
        {
          id: 12,
          route_code: "CPT-BLK",
          bus_id: "GW-1002",
          direction: "OUTBOUND",
          service_day: "WEEKDAY",
          status: "DELAYED",
          delay_minutes: 20,
          note: "Delayed",
          started_at: "2026-09-22T14:32:52Z",
          ended_at: null,
        },
      ],
      error: null,
    });
    h.from.mockReturnValue(b);
    const runs = await fetchMyRuns();
    expect(h.from).toHaveBeenCalledWith("vehicle_runs");
    expect(runs).toEqual([
      {
        id: 12,
        routeCode: "CPT-BLK",
        busId: "GW-1002",
        direction: "OUTBOUND",
        serviceDay: "WEEKDAY",
        status: "DELAYED",
        delayMinutes: 20,
        note: "Delayed",
        startedAt: "2026-09-22T14:32:52Z",
        endedAt: null,
      },
    ]);
  });

  it("only returns the signed-in driver's own runs, never another driver's", async () => {
    const b = queryBuilder({ data: [], error: null });
    h.from.mockReturnValue(b);
    await fetchMyRuns();
    expect(b.ops).toContainEqual(["eq", "driver_id", "driver-uid"]);
  });

  it("returns [] without querying when there is no session", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    expect(await fetchMyRuns()).toEqual([]);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("asks for newest first, capped at 60", async () => {
    const b = queryBuilder({ data: [], error: null });
    h.from.mockReturnValue(b);
    await fetchMyRuns();
    expect(b.ops).toContainEqual(["order", "started_at", { ascending: false }]);
    expect(b.ops).toContainEqual(["limit", 60]);
  });

  it("returns [] when there is no data", async () => {
    h.from.mockReturnValue(queryBuilder({ data: null, error: null }));
    expect(await fetchMyRuns()).toEqual([]);
  });

  it("throws an ApiError when the query fails", async () => {
    h.from.mockReturnValue(queryBuilder({ data: null, error: { code: "42501", message: "denied" } }));
    const err = await fetchMyRuns().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });
});

describe("admin: fetchAllOpenRuns (live fleet)", () => {
  const row = (over = {}) => ({
    id: 1,
    route_code: "KHA-CPT",
    bus_id: "GW-1001",
    direction: "OUTBOUND",
    status: "ON_TIME",
    delay_minutes: 0,
    started_at: "2026-09-22T08:00:00Z",
    staff: { first_name: "Pieter", surname: "Van Wyk" },
    ...over,
  });

  it("only asks for runs that have not ended", async () => {
    const b = queryBuilder({ data: [], error: null });
    h.from.mockReturnValue(b);
    await fetchAllOpenRuns();
    expect(h.from).toHaveBeenCalledWith("vehicle_runs");
    expect(b.ops).toContainEqual(["is", "ended_at", null]);
  });

  it("joins the driver's name onto each run", async () => {
    h.from.mockReturnValue(queryBuilder({ data: [row()], error: null }));
    const [r] = await fetchAllOpenRuns();
    expect(r.driverName).toBe("Pieter Van Wyk");
    expect(r).toMatchObject({ id: 1, routeCode: "KHA-CPT", busId: "GW-1001", status: "ON_TIME", delayMinutes: 0 });
  });

  it("shows a dash when the driver row is not readable", async () => {
    h.from.mockReturnValue(queryBuilder({ data: [row({ staff: null })], error: null }));
    const [r] = await fetchAllOpenRuns();
    expect(r.driverName).toBe("—");
  });

  it("returns [] for no data and throws on error", async () => {
    h.from.mockReturnValue(queryBuilder({ data: null, error: null }));
    expect(await fetchAllOpenRuns()).toEqual([]);
    h.from.mockReturnValue(queryBuilder({ data: null, error: { message: "boom" } }));
    await expect(fetchAllOpenRuns()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("admin: withdrawAlert", () => {
  it("ends the alert now, for that id only", async () => {
    const b = queryBuilder({ error: null });
    h.from.mockReturnValue(b);
    const before = Date.now();
    await expect(withdrawAlert(7)).resolves.toBe(true);
    const after = Date.now();

    expect(h.from).toHaveBeenCalledWith("service_alerts");
    const [, payload] = b.ops.find(([m]) => m === "update");
    const stamped = Date.parse(payload.effective_to);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    expect(b.ops).toContainEqual(["eq", "id", 7]);
  });

  it("never deletes — it only sets effective_to", async () => {
    const b = queryBuilder({ error: null });
    h.from.mockReturnValue(b);
    await withdrawAlert(7);
    const [, payload] = b.ops.find(([m]) => m === "update");
    expect(Object.keys(payload)).toEqual(["effective_to"]);
  });

  it("throws an ApiError when the database refuses", async () => {
    h.from.mockReturnValue(queryBuilder({ error: { code: "42501", message: "denied" } }));
    const err = await withdrawAlert(7).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });
});

describe("inspector", () => {
  it("lookupCardForInspection trims and upper-cases the card number", async () => {
    h.rpc.mockResolvedValue({ data: { cardNumber: "GW123" }, error: null });
    await lookupCardForInspection("  gw123 ");
    expect(h.rpc).toHaveBeenCalledWith("lookup_card_for_inspection", { p_card_number: "GW123" });
  });

  it("logInspectionOutcome trims/upper-cases the card and defaults note to null", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    await logInspectionOutcome(" gw123 ", "VALID");
    expect(h.rpc).toHaveBeenCalledWith("log_inspection_outcome", {
      p_card_number: "GW123",
      p_outcome: "VALID",
      p_note: null,
    });
  });

  it("logInspectionOutcome forwards a note", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    await logInspectionOutcome("GW123", "REFUSED", "Aggressive");
    expect(h.rpc.mock.calls[0][1].p_note).toBe("Aggressive");
  });

  it("fetchMyRecentInspections returns [] without querying when signed out", async () => {
    h.getUser.mockResolvedValue({ data: { user: null } });
    expect(await fetchMyRecentInspections()).toEqual([]);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("fetchMyRecentInspections filters to the signed-in inspector", async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: "inspector-uid" } } });
    const b = queryBuilder({ data: [{ id: 1 }], error: null });
    h.from.mockReturnValue(b);
    expect(await fetchMyRecentInspections(5)).toEqual([{ id: 1 }]);
    expect(h.from).toHaveBeenCalledWith("inspection_events");
    expect(b.ops).toContainEqual(["eq", "inspector_id", "inspector-uid"]);
    expect(b.ops).toContainEqual(["limit", 5]);
  });
});

describe("staff self-service", () => {
  it("deactivateMyAccount calls the deactivate_my_account RPC with no arguments", async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    await deactivateMyAccount();
    expect(h.rpc).toHaveBeenCalledWith("deactivate_my_account", {});
  });
});
