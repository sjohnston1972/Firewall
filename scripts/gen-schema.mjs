// Regenerate schema/ir.json from the Zod source of truth (schema/ir.ts).
// Run: node scripts/gen-schema.mjs   (or `npm run schema:json`)
import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { IR, IRFragment, IR_VERSION } from "../schema/ir.ts";

const doc = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Bastion IR",
  description: `Vendor-neutral firewall desired-state IR v${IR_VERSION}. Generated from schema/ir.ts — do not edit by hand.`,
  definitions: {
    IR: zodToJsonSchema(IR, { name: "IR", $refStrategy: "none" }),
    IRFragment: zodToJsonSchema(IRFragment, { name: "IRFragment", $refStrategy: "none" }),
  },
};

writeFileSync(new URL("../schema/ir.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log("wrote schema/ir.json");
