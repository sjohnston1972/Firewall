/**
 * Driver registry (CLAUDE.md §4.3 / §15).
 * Selects the vendor driver for a session. The rest of the app stays
 * vendor-neutral and only ever touches the FirewallDriver contract.
 */
import { HttpError } from "../types";
import type { DriverContext, FirewallDriver } from "./types";
import { PanosDriver } from "./panos";
import { FortiosDriver } from "./fortios";
import { FtdDriver } from "./ftd";
import { AsaDriver } from "./asa";
import { MerakiDriver } from "./meraki";

export { PanosDriver } from "./panos";
export { FortiosDriver } from "./fortios";
export { FtdDriver } from "./ftd";
export { AsaDriver } from "./asa";
export { MerakiDriver } from "./meraki";

export function getDriver(ctx: DriverContext): FirewallDriver {
  switch (ctx.vendor) {
    case "panos":
      return new PanosDriver(ctx);
    case "fortios":
      return new FortiosDriver(ctx);
    case "ftd":
      return new FtdDriver(ctx);
    case "asa":
      return new AsaDriver(ctx);
    case "meraki":
      return new MerakiDriver(ctx);
    default: {
      const _exhaustive: never = ctx.vendor;
      throw new HttpError(400, `Unknown vendor: ${String(_exhaustive)}`);
    }
  }
}
