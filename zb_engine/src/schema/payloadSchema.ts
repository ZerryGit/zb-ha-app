/**
 * payloadSchema.ts — Zod schema for the top-level JSON payload
 *
 * Per README "JSON Payload Structure":
 *   { "misc": {}, "features": {}, "sources": [], "elements": [] }
 */

import { z } from "zod";
import { sourceSchema } from "./sourceSchema";
import { elementSchema } from "./elementSchema";
import { RESERVED_CONTEXT_ROOTS, BLOCKED_KEYS } from "@zb/expressions";
import { MAX_ELEMENT_NESTING_DEPTH, MAX_TOTAL_ELEMENTS, MAX_SOURCES } from "../limits";

const MAX_CANVAS_DIM = 4096;
const MAX_TOP_LEVEL_ELEMENTS = 2000;

/**
 * Iteratively walk the raw `elements` tree, rejecting payloads that exceed
 * the nesting-depth or total-element bounds.
 *
 * This runs on the UNPARSED array (via `.pipe`, before the recursive
 * discriminated-union parse) for two reasons:
 *   1. Zod's `z.lazy` group recursion would itself blow the stack on a
 *      sufficiently deep payload BEFORE any post-parse `.refine` could fire.
 *      Bounding depth here means the typed parse never recurses past the cap.
 *   2. The walk is iterative (explicit stack, not recursion) and counts each
 *      `group.children` array as it is discovered — so it never recurses
 *      deeply nor buffers an oversized tree, even for adversarial input.
 */
function checkElementBounds(elements: unknown[], ctx: z.RefinementCtx): void {
  let total = elements.length;
  if (total > MAX_TOTAL_ELEMENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Payload exceeds maximum total element count (${MAX_TOTAL_ELEMENTS}).`,
    });
    return;
  }

  const stack: Array<{ node: unknown; depth: number }> = elements.map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_ELEMENT_NESTING_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Element nesting depth exceeds maximum (${MAX_ELEMENT_NESTING_DEPTH}).`,
      });
      return;
    }
    if (node === null || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (obj.type === "group" && Array.isArray(obj.children)) {
      total += obj.children.length;
      if (total > MAX_TOTAL_ELEMENTS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Payload exceeds maximum total element count (${MAX_TOTAL_ELEMENTS}).`,
        });
        return;
      }
      for (const child of obj.children) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
}

/**
 * The `elements` field: a raw structural-bounds gate (depth + total count)
 * piped into the recursive element parse. The bounds check MUST precede the
 * typed parse — see `checkElementBounds`.
 */
const elementsField = z
  .array(z.unknown())
  .max(MAX_TOP_LEVEL_ELEMENTS)
  .default([])
  .superRefine(checkElementBounds)
  .pipe(z.array(elementSchema));

export const miscSchema = z.object({
  size: z.object({
    width: z.number().positive().max(MAX_CANVAS_DIM),
    height: z.number().positive().max(MAX_CANVAS_DIM),
  }),
  format: z.enum(["png", "bin"]).default("png"),
  name: z.string().optional(),
  type: z.string().optional(),
  subcategory: z.string().optional(),
  gridSize: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const payloadSchema = z.object({
  misc: miscSchema,
  // __proto__ requires a two-stage check: Zod's z.record() internally
  // reconstructs the object via assignment, which triggers the JS __proto__
  // setter and silently drops the key. The first stage catches __proto__ on
  // the raw JSON.parse output (where it IS an own enumerable key), before
  // Zod processes it. The second stage (.refine on the record) still catches
  // constructor and prototype, which have no special JS setter semantics.
  features: z.unknown()
    .refine(
      (val) => {
        if (val == null || typeof val !== "object" || Array.isArray(val)) return true;
        return !Object.prototype.hasOwnProperty.call(val, "__proto__");
      },
      { message: "Feature keys must not include __proto__, constructor, or prototype." },
    )
    .pipe(
      z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
        .refine((obj) => Object.keys(obj).length <= 1000, {
          message: "features object exceeds 1000 key limit",
        })
        .refine(
          (obj) => !Object.keys(obj).some((k) => BLOCKED_KEYS.has(k)),
          { message: "Feature keys must not include __proto__, constructor, or prototype." },
        ),
    ),
  sources: z.array(sourceSchema).max(MAX_SOURCES).default([])
    .refine(
      (sources) => {
        const ids = sources.map((s) => s.id);
        return new Set(ids).size === ids.length;
      },
      { message: "Duplicate source IDs are not allowed." },
    )
    .refine(
      (sources) => !sources.some((s) => RESERVED_CONTEXT_ROOTS.has(s.id)),
      { message: "Source IDs must not collide with reserved context names (misc, features, __proto__, constructor, prototype)." },
    ),
  elements: elementsField,
});

/**
 * Schema for a fullscreen companion payload.
 *
 * A widget MAY carry a second payload in addition to its primary one. The
 * companion is locked to grid `3x2` (== fullscreen on the user's chosen
 * display mode). The pixel `misc.size` is whatever `gridSizeToSize("3x2",
 * screenSize)` produced in the builder for the device's screen and is
 * already bounded by `MAX_CANVAS_DIM` via the existing `miscSchema`. The
 * server intentionally has no display-mode awareness \u2014 `gridSize === "3x2"`
 * IS the meaning of "fullscreen".
 */
export const fullscreenPayloadSchema = payloadSchema.refine(
  (p) => p.misc.gridSize === "3x2",
  { message: "Fullscreen payload must have misc.gridSize === \"3x2\"." },
);
