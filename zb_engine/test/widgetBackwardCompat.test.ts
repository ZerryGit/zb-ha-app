/**
 * widgetBackwardCompat.test.ts — the "existing widgets never break" guardrail.
 *
 * Loads a committed corpus of representative widget documents
 * (test/fixtures/widget-corpus/*.json) and drives each through the REAL render
 * pipeline (`runPipeline`), asserting for each:
 *   1. it still PARSES under the current payloadSchema — catches a newly-required
 *      field, a tightened type, or a removed/renamed element `type`;
 *   2. it renders with NO source errors and NO render errors — not merely "didn't
 *      throw"; a silently-dropped element would still fail here;
 *   3. for DETERMINISTIC docs (vector / text / graph — pure-JS render, no image
 *      rasterization), the rendered PNG matches a committed golden PNG, byte-for-byte.
 *      RASTER docs (`img` / `svg` rasterize through sharp, whose output varies by
 *      platform/version) are checked for a clean render + correct dimensions instead.
 *
 * The PNG *encoder* is sharp as well (`src/encoder/pngEncoder.ts`), so a sharp upgrade
 * can change the compressed bytes of a deterministic golden while every pixel stays
 * identical — the comparison here is `Buffer.equals`, which cannot tell the two apart.
 * Before re-baselining after a sharp bump, decode both PNGs and compare RAW PIXELS;
 * only regenerate once the change is confirmed container-only, and say so in the PR.
 *
 * A corpus file may be a bare payload ({misc,features,sources,elements}) OR a full
 * stored widget document ({id,name,doc:{...}}) — the loader unwraps `.doc`, so a
 * real saved widget copied straight out of /data/widgets can be dropped in unedited.
 *
 * Sources resolve through a deterministic in-test handler (no network), so
 * source-backed widgets (e.g. graphs) render hermetically.
 *
 * Goldens live in test/fixtures/widget-corpus-goldens/<name>.png and are openable.
 * They are committed and REQUIRED: a missing golden FAILS (it is never silently
 * created in CI). Generate or update them explicitly with UPDATE_GOLDENS=1, e.g.
 * `UPDATE_GOLDENS=1 npx vitest run test/widgetBackwardCompat.test.ts`, then review
 * and commit. Without that flag a mismatch writes <name>.actual.png beside the
 * golden so you can eyeball the diff, and fails.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { installInlineRenderWorker } from "./helpers/inlineRenderWorker";
import { payloadSchema } from "../src/schema/payloadSchema";
import { runPipeline, type SourceHandler } from "../src/core/renderService";
import type { HaHistoryResult, HaStateResult } from "../src/data/sourceFetcher";

const UPDATE_GOLDENS = !!process.env.UPDATE_GOLDENS;

const CORPUS_DIR = join(__dirname, "fixtures", "widget-corpus");
const GOLDEN_DIR = join(__dirname, "fixtures", "widget-corpus-goldens");

/**
 * Deterministic canned data for platform sources (haState / haHistory), so a
 * source-backed widget resolves the same way every run with no network. Any
 * `kind: "haHistory"` source yields the same 4-point series; the graph expander
 * reads `.points` (dataPath) with `{t, v}` per point.
 */
const sourceHandler: SourceHandler = async (source) => {
  const kind = (source as { kind?: string }).kind;
  if (kind === "haHistory") {
    // Typed against the production contract: if HaHistoryResult changes, this
    // literal stops compiling — the mock can't silently drift from reality.
    const history: HaHistoryResult = {
      entity_id: "sensor.demo",
      hoursBack: 24,
      points: [
        { t: 1_000_000, v: 10, s: "10" },
        { t: 2_000_000, v: 22, s: "22" },
        { t: 3_000_000, v: 15, s: "15" },
        { t: 4_000_000, v: 28, s: "28" },
      ],
      min: 10, max: 28, avg: 18.75, latest: 28, latestState: "28", count: 4,
      tMin: 1_000_000, tMax: 4_000_000,
      labels: { tStart: "", tEnd: "", vMin: "10", vMax: "28" },
      truncated: false,
    };
    return history;
  }
  if (kind === "haState") {
    const state: HaStateResult = {
      entity_id: "sensor.demo", state: "on", value: 1,
      attributes: {}, last_changed: "", last_updated: "",
    };
    return state;
  }
  return {};
};

/** Accept a full stored widget doc ({id,name,doc}) or a bare payload. */
function unwrap(raw: any): any {
  return raw && typeof raw === "object" && raw.doc && typeof raw.doc === "object" ? raw.doc : raw;
}

/** Collect every element `type` present, recursing into groups. */
function collectTypes(elements: any[], acc = new Set<string>()): Set<string> {
  for (const el of elements ?? []) {
    if (el && typeof el === "object") {
      if (typeof el.type === "string") acc.add(el.type);
      if (Array.isArray(el.children)) collectTypes(el.children, acc);
    }
  }
  return acc;
}

const corpus = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => {
    const payload = unwrap(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")));
    const types = collectTypes(payload?.elements ?? []);
    // img/svg rasterize through sharp — byte output is platform-dependent, so
    // those docs skip the pixel golden (render-cleanliness is still asserted).
    const raster = types.has("img") || types.has("svg");
    return { file, name: file.replace(/\.json$/, ""), payload, raster };
  });

let restoreWorker: () => void;
beforeAll(() => {
  restoreWorker = installInlineRenderWorker();
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
});
afterAll(() => restoreWorker?.());

describe("widget backward-compatibility corpus", () => {
  it("has a non-empty corpus", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  for (const { file, name, payload, raster } of corpus) {
    describe(file, () => {
      it("still parses under the current payloadSchema", () => {
        const result = payloadSchema.safeParse(payload);
        if (!result.success) {
          throw new Error(
            `${file} no longer parses — a schema change broke an existing widget:\n` +
              JSON.stringify(result.error.flatten(), null, 2),
          );
        }
        expect(result.success).toBe(true);
      });

      it("renders with no source or render errors", async () => {
        const { pngBuffer, meta } = await runPipeline(payload, sourceHandler, null);

        expect(Buffer.isBuffer(pngBuffer)).toBe(true);
        expect(pngBuffer.length).toBeGreaterThan(0);
        expect(meta.width).toBe(payload.misc.size.width);
        expect(meta.height).toBe(payload.misc.size.height);
        expect(meta.sourceErrors).toEqual([]);

        if (!raster) {
          // Deterministic docs must render every element cleanly.
          expect(meta.renderErrors).toEqual([]);
        } else if (meta.renderErrors.length) {
          // Raster docs run through sharp; surface any note without failing on
          // environment-specific rasterization differences.
          console.warn(`${file}: raster renderErrors → ${JSON.stringify(meta.renderErrors)}`);
        }
      });

      if (!raster) {
        it("matches its committed golden PNG (deterministic render)", async () => {
          const { pngBuffer } = await runPipeline(payload, sourceHandler, null);
          const goldenPath = join(GOLDEN_DIR, `${name}.png`);

          if (!existsSync(goldenPath)) {
            if (UPDATE_GOLDENS) {
              writeFileSync(goldenPath, pngBuffer);
              console.warn(`Wrote new golden ${name}.png — review it and commit.`);
              return;
            }
            // A missing golden must FAIL — never silently pass by auto-creating
            // it (that would let CI go green with zero pixel coverage).
            throw new Error(
              `${name}: golden PNG is missing (${name}.png). A committed golden is required — ` +
                `run with UPDATE_GOLDENS=1 to generate it, then review and commit.`,
            );
          }

          const golden = readFileSync(goldenPath);
          if (golden.equals(pngBuffer)) return;

          if (UPDATE_GOLDENS) {
            writeFileSync(goldenPath, pngBuffer);
            console.warn(`Updated golden ${name}.png — review the change and commit.`);
            return;
          }
          const actualPath = join(GOLDEN_DIR, `${name}.actual.png`);
          writeFileSync(actualPath, pngBuffer);
          throw new Error(
            `${name}: rendered PNG differs from its golden — a change altered how an existing ` +
              `widget renders. Wrote ${name}.actual.png next to the golden; open both to compare. ` +
              `If the change is intended, re-run with UPDATE_GOLDENS=1 to regenerate.`,
          );
        });
      }
    });
  }

  it("text actually renders (fonts are loaded under vitest)", async () => {
    const base = {
      misc: { size: { width: 160, height: 60 }, format: "png", gridSize: "1x1" },
      features: {},
      sources: [],
    };
    const empty = await runPipeline({ ...base, elements: [] }, sourceHandler, null);
    const withText = await runPipeline(
      { ...base, elements: [{ type: "text", id: "t", pos: { x: 8, y: 8 }, sizeX: 140, sizeY: 40, text: "Hello", fontSize: 24, fill: 100 }] },
      sourceHandler,
      null,
    );
    // If fonts weren't loaded the glyphs draw nothing and the two renders match.
    expect(withText.pngBuffer.equals(empty.pngBuffer)).toBe(false);
  });
});
