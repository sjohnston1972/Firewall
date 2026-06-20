// Copy the relay agent into the built assets so the app can serve it for
// download at /relay-agent.mjs (run after `vite build`).
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("agent/relay-agent.mjs", "dist/relay-agent.mjs");
console.log("copied agent/relay-agent.mjs -> dist/relay-agent.mjs");
