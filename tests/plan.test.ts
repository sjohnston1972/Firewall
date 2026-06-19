import { describe, it, expect } from "vitest";
import { buildPlan, diffIR } from "../src/plan/engine";
import { PACKS, applyPacks } from "../src/packs/catalogue";
import { emptyIR } from "../schema/ir";

describe("plan engine", () => {
  it("merges design + fragments + packs deterministically and idempotently", () => {
    const input = {
      vendor: "panos" as const,
      design: {
        system: { hostname: "fw1", dns: ["1.1.1.1"], ntp: ["pool.ntp.org"] },
        zones: [{ name: "trust", type: "trust" as const, interfaces: ["eth1"] }],
      },
      fragments: [
        {
          security: [{ name: "imported-rule", action: "allow" as const }],
          nat: [],
          addresses: [],
          services: [],
          vpn: [],
          warnings: [],
        },
      ],
      enabledPacks: ["outbound-internet-baseline"],
    };
    const a = buildPlan(input);
    const b = buildPlan(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // idempotent
    expect(a.system.hostname).toBe("fw1");
    expect(a.security.some((r) => r.name === "imported-rule")).toBe(true);
    expect(a.security.length).toBeGreaterThan(1); // pack added rules
  });

  it("diffIR reports everything added when before is null", () => {
    const after = buildPlan({
      vendor: "fortios",
      design: { zones: [{ name: "dmz", type: "dmz", interfaces: [] }] },
      fragments: [],
      enabledPacks: [],
    });
    const diff = diffIR(null, after);
    expect(diff.added.length).toBeGreaterThan(0);
    expect(diff.removed.length).toBe(0);
  });

  it("diffIR reports no changes for identical IRs", () => {
    const ir = buildPlan({ vendor: "asa", design: {}, fragments: [], enabledPacks: [] });
    const diff = diffIR(ir, ir);
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0);
  });
});

describe("policy packs", () => {
  it("exposes a catalogue across all four categories", () => {
    const cats = new Set(PACKS.map((p) => p.category));
    expect(cats.has("connectivity")).toBe(true);
    expect(cats.has("security")).toBe(true);
    expect(cats.has("access")).toBe(true);
    expect(cats.has("management")).toBe(true);
    expect(PACKS.length).toBeGreaterThanOrEqual(10);
  });

  it("applyPacks is idempotent (re-applying yields identical IR)", () => {
    const base = emptyIR("panos");
    const ids = PACKS.map((p) => p.id);
    const once = applyPacks(base, ids);
    const twice = applyPacks(once, ids);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it("pack rules are tagged with origin and removed cleanly when disabled", () => {
    const base = emptyIR("panos");
    const withPack = applyPacks(base, ["outbound-internet-baseline"]);
    const tagged = withPack.security.filter((r) => r.origin === "pack:outbound-internet-baseline");
    expect(tagged.length).toBeGreaterThan(0);
    const without = applyPacks(withPack, []);
    expect(without.security.some((r) => r.origin === "pack:outbound-internet-baseline")).toBe(false);
  });
});
