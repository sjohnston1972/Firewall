import { describe, it, expect } from "vitest";
import { IR, IRFragment, validateIR, validateFragment, emptyIR } from "../schema/ir";

describe("IR schema", () => {
  it("builds a valid empty IR per vendor with defaults applied", () => {
    const ir = emptyIR("panos");
    expect(ir.meta.vendor).toBe("panos");
    expect(ir.meta.irVersion).toBe("1.0.0");
    expect(ir.protection.floodProtection).toBe(true);
    expect(Array.isArray(ir.security)).toBe(true);
  });

  it("rejects an invalid CIDR in a static interface", () => {
    const res = validateIR({
      meta: { vendor: "panos" },
      interfaces: [{ name: "eth1", addressing: { mode: "static", address: "not-a-cidr" } }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].path).toContain("address");
  });

  it("accepts a well-formed security rule", () => {
    const res = validateIR({
      meta: { vendor: "fortios" },
      security: [{ name: "allow-web", action: "allow", sourceZones: ["trust"], destZones: ["untrust"] }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ir.security[0].log).toBe(true); // default
  });

  it("fragment validation forbids nothing it shouldn't and applies defaults", () => {
    const res = validateFragment({
      nat: [{ name: "snat", type: "source", translatedSource: "1.2.3.4" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fragment.nat[0].bidirectional).toBe(false);
      expect(res.fragment.warnings).toEqual([]);
    }
  });

  it("round-trips through zod parse deterministically", () => {
    const a = IR.parse({ meta: { vendor: "asa" } });
    const b = IR.parse(JSON.parse(JSON.stringify(a)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("IRFragment is its own type and parses an empty object", () => {
    const f = IRFragment.parse({});
    expect(f.security).toEqual([]);
  });
});
