/**
 * Plan engine (CLAUDE.md §4.1 step [4]). Deterministically merges the engineer's
 * design, the accepted AI-normalised import fragments, and the enabled policy
 * packs into a single IR build plan, then validates it through the IR schema.
 *
 * DETERMINISM (CLAUDE.md §2): there is NO AI in this path. The merge order is
 * fixed (design → +fragments → +packs), objects/rules are de-duplicated by
 * `name` with later sources winning while keeping stable ordering, and running
 * buildPlan twice on the same input yields an identical IR.
 */
import { z } from "zod";
import { IR, IRFragment } from "../../schema/ir";
import type { Vendor } from "../types";
import { applyPacks } from "../packs/catalogue";

// Input (pre-parse) shapes — buildPlan validates through the schema, so callers
// (the GUI wire payload, accepted fragments) may pass loose/partial data.
type IRInput = z.input<typeof IR>;
type FragmentInput = z.input<typeof IRFragment>;

export interface PlanInput {
  vendor: Vendor;
  /** interfaces, zones, system, protection, ngfw, addresses, services from the GUI */
  design: Partial<IRInput>;
  /** accepted AI-normalised imports */
  fragments: FragmentInput[];
  enabledPacks: string[];
}

/** Merge by `name`; later entries win but keep their original slot (stable). */
function mergeByName<T extends { name: string }>(...lists: T[][]): T[] {
  const out: T[] = [];
  const index = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) {
      const at = index.get(item.name);
      if (at === undefined) {
        index.set(item.name, out.length);
        out.push(item);
      } else {
        out[at] = item;
      }
    }
  }
  return out;
}

/**
 * Build the IR plan deterministically. Order: design forms the base, accepted
 * import fragments layer on top (NAT/ACL/VPN + referenced objects only), then
 * the enabled policy packs are applied last. The result is schema-validated.
 */
export function buildPlan(input: PlanInput): IR {
  const d = input.design;

  // Base from design. System/protection/ngfw/interfaces/zones come ONLY from the
  // design (fragments are forbidden from setting these — CLAUDE.md §11/§4.4).
  const base: IR = IR.parse({
    // input.vendor is authoritative — it wins over any vendor in design.meta.
    meta: { ...(d.meta ?? {}), vendor: input.vendor },
    interfaces: d.interfaces ?? [],
    zones: d.zones ?? [],
    system: d.system ?? {},
    addresses: d.addresses ?? [],
    services: d.services ?? [],
    nat: d.nat ?? [],
    security: d.security ?? [],
    vpn: d.vpn ?? [],
    routes: d.routes ?? [],
    ngfw: d.ngfw ?? [],
    protection: d.protection ?? {},
  });

  // Layer accepted fragments (NAT/ACL/VPN + referenced objects only).
  // Normalise each fragment through the schema so defaults are applied and the
  // optional/loose input shape becomes a full, mergeable IRFragment.
  const frags = input.fragments.map((f) => IRFragment.parse(f));
  base.addresses = mergeByName(base.addresses, frags.flatMap((f) => f.addresses));
  base.services = mergeByName(base.services, frags.flatMap((f) => f.services));
  base.nat = mergeByName(base.nat, frags.flatMap((f) => f.nat));
  base.security = mergeByName(base.security, frags.flatMap((f) => f.security));
  base.vpn = mergeByName(base.vpn, frags.flatMap((f) => f.vpn));
  base.routes = mergeByName(base.routes, frags.flatMap((f) => f.routes));

  // Apply policy packs last; applyPacks is itself idempotent + returns a new IR.
  const withPacks = applyPacks(base, input.enabledPacks);

  // Final canonical validation pass.
  return IR.parse(withPacks);
}

// ---------- diff ----------
export interface PlanDiff {
  summary: string;
  sections: Record<string, { added: number; removed: number; changed: number }>;
  added: string[]; // human-readable "section: name" lines
  removed: string[];
  changed: string[];
}

type Named = { name: string };

/** Compare two named-item arrays; "changed" = same name, different JSON. */
function diffNamed(
  section: string,
  before: Named[],
  after: Named[],
  acc: { added: string[]; removed: string[]; changed: string[] },
): { added: number; removed: number; changed: number } {
  const beforeMap = new Map(before.map((i) => [i.name, i]));
  const afterMap = new Map(after.map((i) => [i.name, i]));
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const item of after) {
    const prev = beforeMap.get(item.name);
    if (!prev) {
      added++;
      acc.added.push(`${section}: ${item.name}`);
    } else if (JSON.stringify(prev) !== JSON.stringify(item)) {
      changed++;
      acc.changed.push(`${section}: ${item.name}`);
    }
  }
  for (const item of before) {
    if (!afterMap.has(item.name)) {
      removed++;
      acc.removed.push(`${section}: ${item.name}`);
    }
  }
  return { added, removed, changed };
}

/** Scalar section compare (system / protection): one "changed" if JSON differs. */
function diffScalar(
  section: string,
  before: unknown,
  after: unknown,
  acc: { changed: string[] },
): { added: number; removed: number; changed: number } {
  const differs = JSON.stringify(before) !== JSON.stringify(after);
  if (differs) acc.changed.push(`${section}: (settings)`);
  return { added: 0, removed: 0, changed: differs ? 1 : 0 };
}

/**
 * Human-readable diff between two IRs. `before = null` means a fresh build, so
 * everything in `after` counts as "added".
 */
export function diffIR(before: IR | null, after: IR): PlanDiff {
  const acc = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  const sections: PlanDiff["sections"] = {};

  const empty: IR = before ?? IR.parse({ meta: { vendor: after.meta.vendor } });

  sections.interfaces = diffNamed("interfaces", empty.interfaces, after.interfaces, acc);
  sections.zones = diffNamed("zones", empty.zones, after.zones, acc);
  sections.addresses = diffNamed("addresses", empty.addresses, after.addresses, acc);
  sections.services = diffNamed("services", empty.services, after.services, acc);
  sections.nat = diffNamed("nat", empty.nat, after.nat, acc);
  sections.security = diffNamed("security", empty.security, after.security, acc);
  sections.vpn = diffNamed("vpn", empty.vpn, after.vpn, acc);
  sections.routes = diffNamed("routes", empty.routes, after.routes, acc);
  sections.ngfw = diffNamed("ngfw", empty.ngfw, after.ngfw, acc);

  // For a brand-new build, treat scalars as "added" if non-default presence is
  // meaningful; we still report them via the scalar comparison against an empty
  // baseline so the engineer sees the settings will be written.
  sections.system = diffScalar("system", before ? empty.system : null, after.system, acc);
  sections.protection = diffScalar(
    "protection",
    before ? empty.protection : null,
    after.protection,
    acc,
  );

  const totalAdded = acc.added.length;
  const totalRemoved = acc.removed.length;
  const totalChanged = acc.changed.length;
  const summary =
    before === null
      ? `New build: ${totalAdded} added, ${totalChanged} settings changed.`
      : `${totalAdded} added, ${totalRemoved} removed, ${totalChanged} changed.`;

  return {
    summary,
    sections,
    added: acc.added,
    removed: acc.removed,
    changed: acc.changed,
  };
}
