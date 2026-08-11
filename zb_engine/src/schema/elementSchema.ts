/**
 * elementSchema.ts — Zod schema for element types + shared properties
 *
 * Per README "Shared Properties" and "Element Types".
 * Fields that support bindings use z.unknown() — they are resolved at runtime.
 * The schema validates the structural shape; the renderer validates resolved values.
 */

import { z } from "zod";
import { MAX_GEOMETRY_COORD } from "../limits";

// ── Shared sub-schemas (reused across element types) ───────────

/**
 * Geometry field that supports runtime bindings but rejects non-finite or
 * absurd numeric LITERALS. The refinement fires ONLY when the value
 * is `typeof === "number"`, so binding strings (`"={{...}}"`), binding objects
 * (`{ "$": "path" }`), and expression objects (`{ "+": [...] }`) still pass
 * validation unchanged and are bounded later by the pre-render geometry clamp.
 * `.default(dflt)` reuses the field's existing default exactly.
 */
const geometryNumber = (dflt: unknown) =>
  z
    .unknown()
    .superRefine((val, ctx) => {
      if (
        typeof val === "number" &&
        (!Number.isFinite(val) || Math.abs(val) > MAX_GEOMETRY_COORD)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `geometry value must be a finite number within +/-${MAX_GEOMETRY_COORD}`,
        });
      }
    })
    .default(dflt);

const pointSchema = z
  .object({ x: geometryNumber(0), y: geometryNumber(0) })
  .default({ x: 0, y: 0 });

/** Scale point defaults to 1,1 (identity) instead of 0,0 */
const scalePointSchema = z
  .object({ x: z.unknown().default(1), y: z.unknown().default(1) })
  .default({ x: 1, y: 1 });

/** Transform: pos, rotationDeg, scale, origin */
const transformFields = {
  pos: pointSchema,
  rotationDeg: z.unknown().default(0),
  scale: scalePointSchema,
  origin: pointSchema,
};

/** Size: sizeX, sizeY */
const sizeFields = {
  sizeX: geometryNumber(0),
  sizeY: geometryNumber(0),
};

/** Fill dither: enableFill, fill */
const fillFields = {
  enableFill: z.unknown().default(false),
  fill: z.unknown().default(0),
};

/** Stroke: all shared stroke properties */
const strokeFields = {
  enableStroke: z.unknown().default(false),
  strokeDither: z.unknown().default(100),
  strokeWidth: geometryNumber(1),
  strokeDash: z.unknown().default([]),
  strokeCap: z.unknown().default("butt"),
  strokePosition: z.unknown().default("center"),
  strokeRadius: z.unknown().default(0),
};

/** Opacity */
const opacityField = {
  opacity: z.unknown().default(100),
};

/** Visibility */
const visibilityField = {
  visible: z.unknown().default(true),
};

/** Identity: id and name survive through validation for round-trip fidelity */
const identityFields = {
  id: z.string().optional(),
  name: z.string().optional(),
};

// ── Per-type schemas ───────────────────────────────────────────

const rectSchema = z.object({
  type: z.literal("rect"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...sizeFields,
  ...fillFields,
  ...strokeFields,
  ...opacityField,
});

const circleSchema = z.object({
  type: z.literal("circle"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...sizeFields,
  ...fillFields,
  // Stroke without strokeRadius (not applicable to circle)
  enableStroke: z.unknown().default(false),
  strokeDither: z.unknown().default(100),
  strokeWidth: geometryNumber(1),
  strokeDash: z.unknown().default([]),
  strokeCap: z.unknown().default("butt"),
  strokePosition: z.unknown().default("center"),
  // Circle-specific
  arcStartDeg: z.unknown().default(0),
  arcEndDeg: z.unknown().default(0),
  innerSize: z.unknown().default(0),
  ...opacityField,
});

const lineSchema = z.object({
  type: z.literal("line"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  // Line uses points, not sizeX/sizeY. Points are bare numbers (no binding
  // support), so the finite+range bound rejects literal Infinity / absurd
  // coordinates here; the pre-render clamp further tightens survivors to
  // canvas scale. Array length is intentionally left uncapped here; a
  // pathological many-segment line is bounded by the render-timeout backstop.
  points: z
    .array(
      z.tuple([
        z.number().finite().min(-MAX_GEOMETRY_COORD).max(MAX_GEOMETRY_COORD),
        z.number().finite().min(-MAX_GEOMETRY_COORD).max(MAX_GEOMETRY_COORD),
      ]),
    )
    .default([]),
  ...strokeFields,
  ...opacityField,
});

const textSchema = z.object({
  type: z.literal("text"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...sizeFields,
  ...fillFields,
  // Text-specific
  text: z.unknown().default(""),
  fallbackText: z.unknown().default(""),
  fontFamily: z.unknown().default("sans-serif"),
  fontSize: z.unknown().default(16),
  fontWeight: z.unknown().default(400),
  textAlign: z.unknown().default("left"),
  lineHeight: z.unknown().default(1.2),
  // "fixed" wraps the resolved value to the authored sizeX and treats sizeY as
  // a minimum. Anything else — including absent, which is every widget saved
  // before 0.1.4 — means "auto", today's shrink-to-fit behaviour.
  textFlow: z.unknown().default("auto"),
  ...opacityField,
});

const imgSchema = z.object({
  type: z.literal("img"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...sizeFields,
  src: z.unknown(),
  bwMode: z.unknown().default("threshold"),
  bwLevel: z.unknown().default(50),
  ...opacityField,
});

const svgSchema = z.object({
  type: z.literal("svg"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...sizeFields,
  ...fillFields,
  ...strokeFields,
  svg: z.unknown().default(""),
  src: z.unknown().default(""),
  bwMode: z.unknown().default("threshold"),
  bwLevel: z.unknown().default(50),
  ...opacityField,
});

// Group: recursive — uses z.lazy
const baseGroupSchema = z.object({
  type: z.literal("group"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...opacityField,
});

// Graph: expanded into primitives at render time (never reaches the draw engine)
const graphSchema = z.object({
  type: z.literal("graph"),
  ...identityFields,
  ...visibilityField,
  ...transformFields,
  ...sizeFields,
  ...opacityField,

  // Chart configuration
  chartType: z.unknown().default("line"),
  sourceId: z.unknown().default(""),
  dataPath: z.unknown().default("points"),
  valuePath: z.unknown().default("v"),
  timePath: z.unknown().default("t"),
  resolution: z.unknown().default(100),
  dataRangeStart: z.unknown().default(0),
  dataRangeEnd: z.unknown().default(100),

  // Axis & grid
  showAxes: z.unknown().default(true),
  showGrid: z.unknown().default(true),
  gridLines: z.unknown().default(4),
  showLabels: z.unknown().default(true),
  labelFontSize: z.unknown().default(10),
  labelFontWeight: z.unknown().default(400),
  showXEndLabel: z.unknown().default(false),
  xLabelInterval: z.unknown().default(0),
  xLabelRotation: z.unknown().default(0),
  showDateLabels: z.unknown().default(true),

  // Title
  showTitle: z.unknown().default(false),
  titleText: z.unknown().default(""),
  titleFontSize: z.unknown().default(10),
  titleFontWeight: z.unknown().default(600),
  titleDither: z.unknown().default(100),

  // Y-axis range (null = auto)
  yMin: z.unknown().default(null),
  yMax: z.unknown().default(null),

  // Line chart styling
  lineStrokeWidth: z.unknown().default(2),
  lineStrokeDither: z.unknown().default(100),
  lineStrokeRadius: z.unknown().default(0),

  // Bar chart styling
  barGap: z.unknown().default(2),
  barFillDither: z.unknown().default(100),
  barStrokeEnabled: z.unknown().default(false),
  barStrokeDither: z.unknown().default(100),

  // Axis styling
  axisDither: z.unknown().default(100),
  gridDither: z.unknown().default(40),
  gridDash: z.unknown().default([2, 3]),
  labelDither: z.unknown().default(100),
});

// ── Discriminated union (with lazy for group recursion) ────────

export const elementSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.discriminatedUnion("type", [
    rectSchema,
    circleSchema,
    lineSchema,
    textSchema,
    imgSchema,
    svgSchema,
    graphSchema,
    baseGroupSchema.extend({
      children: z.array(elementSchema).default([]),
    }),
  ]),
);
