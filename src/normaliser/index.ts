/**
 * The AI normaliser (CLAUDE.md §11/§13) — the ONLY AI component in Bastion.
 *
 * Job: take messy source config (any format) and emit a validated IR fragment
 * for NAT / ACL / VPN. Nothing else.
 *
 * Hard constraints (CLAUDE.md §2/§11):
 *  - Output MUST validate against the IRFragment schema; reject + retry on
 *    failure, then fail closed (ok: false) rather than emitting garbage.
 *  - No network access to firewalls; this module never touches a device and is
 *    absent from the apply path.
 *  - Ambiguity (any/any rules, unknown services) is surfaced as warnings, never
 *    silently guessed.
 *  - The caller always shows the result to a human as a before/after diff and
 *    requires explicit acceptance before it joins a plan.
 */
import { validateFragment, type IRFragment } from "../../schema/ir";
import type { Env, Vendor } from "../types";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

export interface NormaliseInput {
  vendor: Vendor;
  sourceText: string;
  format?: string;
  /** escalate to the harder model for large/cross-vendor conversions. */
  hard?: boolean;
}

export interface NormaliseResult {
  ok: boolean;
  model: string;
  fragment?: IRFragment;
  errors?: { path: string; message: string }[];
  warnings: { item: string; reason: string; severity: "info" | "warn" | "danger" }[];
  /** caller stores the raw response separately; left undefined here. */
  rawResponseRef?: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

interface AnthropicTextBlock {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content?: AnthropicTextBlock[];
  error?: { type?: string; message?: string };
}

/** Strip markdown code fences and surrounding prose, returning the JSON body. */
function extractJson(text: string): string {
  let t = text.trim();

  // Remove a leading ```json / ``` fence and its closing fence if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence && fence[1] !== undefined) {
    t = fence[1].trim();
  }

  // If there is still leading/trailing prose, slice to the outermost braces.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first > 0 || (last >= 0 && last < t.length - 1)) {
    if (first !== -1 && last !== -1 && last > first) {
      t = t.slice(first, last + 1);
    }
  }
  return t.trim();
}

/** Pull the assistant text out of the Messages API response shape. */
function firstText(resp: AnthropicResponse): string | undefined {
  if (!resp.content) return undefined;
  for (const block of resp.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

interface CallOutcome {
  ok: boolean;
  text?: string;
  error?: { path: string; message: string };
}

/** One round-trip to the Anthropic Messages API. Never throws. */
async function callModel(
  env: Env,
  model: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<CallOutcome> {
  let httpResp: Response;
  try {
    httpResp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: { path: "fetch", message: `network error: ${(e as Error).message}` },
    };
  }

  let parsed: AnthropicResponse;
  try {
    parsed = (await httpResp.json()) as AnthropicResponse;
  } catch (e) {
    return {
      ok: false,
      error: {
        path: "response",
        message: `non-JSON API response (status ${httpResp.status}): ${(e as Error).message}`,
      },
    };
  }

  if (!httpResp.ok || parsed.error) {
    const msg = parsed.error?.message ?? `HTTP ${httpResp.status}`;
    return { ok: false, error: { path: "api", message: msg } };
  }

  const text = firstText(parsed);
  if (text === undefined) {
    return {
      ok: false,
      error: { path: "content", message: "no text block in API response" },
    };
  }
  return { ok: true, text };
}

/**
 * Normalise source config into an IR fragment. Calls the Anthropic Messages API
 * via global fetch, demands JSON-only output, schema-validates, and retries once
 * with a corrective instruction on parse/validation failure. Fails closed.
 */
export async function normalise(env: Env, input: NormaliseInput): Promise<NormaliseResult> {
  const model = input.hard ? env.NORMALISER_MODEL_HARD : env.NORMALISER_MODEL;
  const system = buildSystemPrompt(input.vendor);
  const userPrompt = buildUserPrompt(input.sourceText, input.format);

  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: userPrompt },
  ];

  // Up to two attempts: original, then a corrective retry with the errors.
  let lastErrors: { path: string; message: string }[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await callModel(env, model, system, messages);

    if (!outcome.ok) {
      // Transport / API failure — record and stop (a retry won't fix it).
      return {
        ok: false,
        model,
        errors: outcome.error ? [outcome.error] : [{ path: "api", message: "unknown error" }],
        warnings: [],
      };
    }

    const raw = outcome.text ?? "";
    const jsonText = extractJson(raw);

    let candidate: unknown;
    try {
      candidate = JSON.parse(jsonText);
    } catch (e) {
      lastErrors = [{ path: "json", message: `JSON parse failed: ${(e as Error).message}` }];
      // Feed the bad output back for a corrective retry.
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: correctiveInstruction(lastErrors),
      });
      continue;
    }

    const validation = validateFragment(candidate);
    if (validation.ok) {
      const fragment = validation.fragment;
      return {
        ok: true,
        model,
        fragment,
        // Surface the model's own flagged ambiguities to the caller.
        warnings: fragment.warnings.map((w) => ({
          item: w.item,
          reason: w.reason,
          severity: w.severity,
        })),
      };
    }

    // Schema validation failed — retry once with the specific errors.
    lastErrors = validation.errors;
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: correctiveInstruction(lastErrors) });
  }

  return { ok: false, model, errors: lastErrors, warnings: [] };
}

/** Build a corrective follow-up instruction listing the validation errors. */
function correctiveInstruction(errors: { path: string; message: string }[]): string {
  const lines = errors.map((e) => `- ${e.path}: ${e.message}`).join("\n");
  return `Your previous response did not produce a valid IR fragment. Fix these
issues and return the corrected JSON object ONLY (no prose, no code fences, first
character "{"):

${lines}`;
}
