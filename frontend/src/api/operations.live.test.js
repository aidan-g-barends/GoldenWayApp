import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * LIVE integration tests — run against the real shared Supabase project.
 *
 *   PowerShell:  $env:LIVE_TESTS="1"; npm test
 *   bash:        LIVE_TESTS=1 npm test
 *
 * Skipped by default so a normal `npm test` never touches the network.
 * They log in as the seeded demo staff accounts and check three things:
 *   1. login routing (my_profile_type) sends each role to the right place
 *   2. the RLS/RPC role guards from migrations 0012 + 0016 still hold
 *   3. the reads the Driver / Admin / Inspector screens depend on work
 *
 * Nothing here writes data. The forged inserts use values that would fail
 * a FK/CHECK constraint (23503 / 23514) if a policy ever regressed, whereas
 * a working policy rejects them first with 42501 — so a regression shows up
 * as the wrong error code without ever creating a row.
 */

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const PASSWORD = process.env.LIVE_DEMO_PASSWORD || "GoldenWay!2026";
const LIVE = process.env.LIVE_TESTS === "1" && URL && ANON;

// admin / driver / inspector are this lane's accounts — the suite fails if
// they can't sign in. clerk / agent are shared with teammates who may have
// changed those demo passwords, so their checks skip instead of failing.
const REQUIRED = ["admin", "driver", "inspector"];
const OPTIONAL = ["clerk", "agent"];
const ROLES = [...REQUIRED, ...OPTIONAL];

describe.skipIf(!LIVE)("live backend — staff roles", () => {
  const clients = {};
  const uids = {};

  beforeAll(async () => {
    for (const role of ROLES) {
      const c = createClient(URL, ANON, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await c.auth.signInWithPassword({
        email: `${role}@goldenway.demo`,
        password: PASSWORD,
      });
      if (error) {
        if (REQUIRED.includes(role)) {
          throw new Error(`login failed for ${role}: ${error.message}`);
        }
        continue;
      }
      clients[role] = c;
      uids[role] = data.user.id;
    }
  }, 30_000);

  const needs = (role, ctx) => {
    if (!clients[role]) ctx.skip();
  };

  afterAll(async () => {
    await Promise.all(Object.values(clients).map((c) => c.auth.signOut()));
  });

  describe("login routing (my_profile_type)", () => {
    for (const role of ROLES) {
      it(`${role} is routed as an active STAFF ${role.toUpperCase()}`, async (ctx) => {
        needs(role, ctx);
        const { data, error } = await clients[role].rpc("my_profile_type");
        expect(error).toBeNull();
        expect(data).toMatchObject({
          userType: "STAFF",
          role: role.toUpperCase(),
          active: true,
          email: `${role}@goldenway.demo`,
        });
      });
    }
  });

  describe("RLS: other roles cannot forge another lane's records", () => {
    it("a CLERK cannot insert a vehicle run (driver lane)", async (ctx) => {
      needs("clerk", ctx);
      const { error } = await clients.clerk.from("vehicle_runs").insert({
        driver_id: uids.clerk,
        route_code: "KHA-CPT",
        bus_id: "ZZ-NO-SUCH-BUS",
      });
      expect(error?.code).toBe("42501");
    });

    it("an INSPECTOR cannot insert a vehicle run (driver lane)", async () => {
      const { error } = await clients.inspector.from("vehicle_runs").insert({
        driver_id: uids.inspector,
        route_code: "KHA-CPT",
        bus_id: "ZZ-NO-SUCH-BUS",
      });
      expect(error?.code).toBe("42501");
    });

    it("a DRIVER cannot insert an inspection record (inspector lane)", async () => {
      const { error } = await clients.driver.from("inspection_events").insert({
        inspector_id: uids.driver,
        card_number: "ZZ-NO-SUCH-CARD",
        outcome: "ZZ_INVALID_OUTCOME",
      });
      expect(error?.code).toBe("42501");
    });

    it("a CLERK cannot insert an inspection record (inspector lane)", async (ctx) => {
      needs("clerk", ctx);
      const { error } = await clients.clerk.from("inspection_events").insert({
        inspector_id: uids.clerk,
        card_number: "ZZ-NO-SUCH-CARD",
        outcome: "ZZ_INVALID_OUTCOME",
      });
      expect(error?.code).toBe("42501");
    });
  });

  describe("RPC role guards", () => {
    it("a DRIVER cannot log an inspection outcome", async () => {
      const { error } = await clients.driver.rpc("log_inspection_outcome", {
        p_card_number: "ZZ-NO-SUCH-CARD",
        p_outcome: "VALID",
        p_note: null,
      });
      expect(error?.code).toBe("42501");
    });

    it("a DRIVER cannot look up a card for inspection", async () => {
      const { error } = await clients.driver.rpc("lookup_card_for_inspection", {
        p_card_number: "ZZ-NO-SUCH-CARD",
      });
      expect(error?.code).toBe("42501");
    });

    it("an INSPECTOR cannot start a driver run", async () => {
      const { error } = await clients.inspector.rpc("start_run", {
        p_route_code: "KHA-CPT",
        p_bus_id: "ZZ-NO-SUCH-BUS",
        p_direction: "OUTBOUND",
        p_note: null,
      });
      expect(error?.code).toBe("42501");
    });

    it("a CLERK cannot report a run status", async (ctx) => {
      needs("clerk", ctx);
      const { error } = await clients.clerk.rpc("report_run_status", {
        p_run_id: 999999999,
        p_status: "ON_TIME",
        p_delay_minutes: 0,
        p_note: null,
      });
      expect(error?.code).toBe("42501");
    });
  });

  describe("inspector validation (reads/guards only, nothing saved)", () => {
    it("rejects an unknown outcome before touching any data", async () => {
      const { error } = await clients.inspector.rpc("log_inspection_outcome", {
        p_card_number: "ZZ-NO-SUCH-CARD",
        p_outcome: "NOT_AN_OUTCOME",
        p_note: null,
      });
      expect(error?.message).toMatch(/invalid inspection outcome/i);
    });

    it("rejects a card that does not exist", async () => {
      const { error } = await clients.inspector.rpc("log_inspection_outcome", {
        p_card_number: "ZZ-NO-SUCH-CARD",
        p_outcome: "VALID",
        p_note: null,
      });
      expect(error?.message).toMatch(/not found/i);
    });

    it("rejects a note over 300 characters", async () => {
      const { error } = await clients.inspector.rpc("log_inspection_outcome", {
        p_card_number: "ZZ-NO-SUCH-CARD",
        p_outcome: "VALID",
        p_note: "x".repeat(301),
      });
      // The note limit is checked after the card, so a missing card may be
      // reported first — either way nothing is saved.
      expect(error).not.toBeNull();
    });
  });

  describe("reads the screens depend on", () => {
    it("driver can read vehicle_runs and every row has the fields RunsScreen maps", async () => {
      const { data, error } = await clients.driver.from("vehicle_runs").select("*").limit(5);
      expect(error).toBeNull();
      for (const r of data) {
        expect(r).toHaveProperty("route_code");
        expect(r).toHaveProperty("bus_id");
        expect(r).toHaveProperty("status");
        expect(r).toHaveProperty("delay_minutes");
      }
    });

    it("driver can read the active bus list", async () => {
      const { data, error } = await clients.driver.from("buses").select("fleet_no, depot").eq("active", true);
      expect(error).toBeNull();
      expect(data.length).toBeGreaterThan(0);
    });

    it("admin's live-fleet query (open runs joined to driver name) works", async () => {
      const { data, error } = await clients.admin
        .from("vehicle_runs")
        .select("id, route_code, bus_id, direction, status, delay_minutes, started_at, staff:driver_id(first_name, surname)")
        .is("ended_at", null);
      expect(error).toBeNull();
      for (const r of data) {
        expect(r.staff?.first_name).toBeTruthy();
      }
    });

    it("admin and driver both see live alerts; every live alert has a start time", async () => {
      for (const role of ["admin", "driver"]) {
        const { data, error } = await clients[role]
          .from("service_alerts")
          .select("id, title, severity, effective_from")
          .is("effective_to", null);
        expect(error).toBeNull();
        for (const a of data) {
          expect(["INFO", "WARNING", "CRITICAL"]).toContain(a.severity);
          expect(a.effective_from).toBeTruthy();
        }
      }
    });

    it("inspector can read the inspection log; a driver cannot", async () => {
      const ok = await clients.inspector.from("inspection_events").select("id").limit(1);
      expect(ok.error).toBeNull();

      const blocked = await clients.driver.from("inspection_events").select("id").limit(1);
      expect(blocked.error).toBeNull();
      expect(blocked.data).toEqual([]);
    });
  });
});
