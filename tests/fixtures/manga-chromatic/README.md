# Frozen chromatic source corpus

Eight original scenes contain 23 complete source anchors, 22 explicit paragraphs, eight wordless regions and 24 opaque protected pixels. Two RGBA scenes also have six exact source RGBA probes. Each page is 900 × 900; the eight PNGs total 173,939 bytes. This independent suite preserves the previous 43 images and all their truth. The assets are test inputs and are not bundled with the extension.

The design was frozen at **2026-10-25 10:04:02 UTC**, before generation and any OCR. Its SHA-256 is `1287de36a49b5002a2ee1e0a2be683a685ca30db40a9efa5288e35fa605935e6`; the original evidence manifest is `6df6d41cbeba20ff239fe7ca533333f0c2b7957b100333b23aefdcf42d6556fb`. Repository migration changes only the manifest's top-level generator path and generator SHA. Every PNG, design byte and fixture object remains identical to that first freeze. Never adjust this truth to match later recognition.

| Scene | Structure and pressure |
| --- | --- |
| `white-red-magenta-independent-labels` | Pure red and magenta on white; three independent labels, including a gray control. |
| `black-cyan-oxygen-hud` | Cyan two-line instruction on black and a separate amber time. |
| `equal-luma-red-green-cards` | Opposing red/green cards with equal rounded BT601 base-color luminance and a neutral control. |
| `translucent-red-dialogue-overlay` | Actual RGBA red dialogue overlays, low-brightness art and a separate gray reference. |
| `translucent-cyan-night-hud` | Actual RGBA cyan HUD, opaque protected icons and a white reference. |
| `thin-aa-gray-and-chromatic-tail` | Four-times sampled Latin/CJK, gray descenders and digits, near-white gray and a complete black-prefix/pink-tail line. |
| `mixed-color-edge-screenshot` | Nonuniform colored screenshot, separate opposing-color door tags and gray text on a mixed border. |
| `wordless-chromatic-diagram` | Entirely wordless geometric artwork; the whole image is a strict negative region. **Manga profile only; exclude it from ordinary-image manifests.** |

The recognition-only color proposal was discussed before generation. Cases cover both R-only contrast loss and useful contrast that a global luminance conversion loses. Red `[255,0,0]` has BT601 luminance 76.245; green `[0,130,0]` has 76.310. Both round to 76, while their R channels differ by 255. These are base opaque colors; antialiasing need not preserve equal luminance. Detection and resizing decide actual model crop edges; this corpus does not prescribe them.

Artwork and source strings are original. Local Arial Bold, Arial and Hiragino W4 are referenced by exact SHA; no fonts, models or third-party artwork are included. Reproduction requires **Pillow 12.3.0** and the same font bytes. Explicit paths can be supplied with `--bold-font`, `--regular-font` and `--cjk-font`.

From the repository root:

```sh
python-with-pillow-12.3 scripts/testing/generate-manga-chromatic-fixtures.py --out-dir /new/unused/output
node scripts/testing/check-manga-chromatic-fixtures.cjs
```

The generator accepts only a nonexistent output path, including rejection of empty directories and dangling symlinks. It validates exact design/fonts/Pillow, every render, bounds, negatives, protections and the complete frozen manifest before exclusive directory/file creation. Its default reference is this repository manifest; `--design` and `--reference-manifest` accept the original evidence paths. Independent fixed content digests permit only the documented generator provenance fields to differ. Source glyph bounds come from rendered alpha masks; low-contrast tails and small text retain their complete source anchors.

The Node checker requires no Pillow, fonts, models or browser. It pins the complete manifest content, design and PNG hashes before quality evaluation, accepts eight perfect source replays, and rejects 23 single-character misreads, eight artwork-region injections, seven extra-text injections, seven independent-paragraph conflations, a missing colored tail and wordless false text. These checks prove input and gate integrity, not OCR accuracy.

`first-ocr-baseline.json` retains all eight actual final source/transport values, physical OCR boxes, paragraph checks, inventories, negatives, protected pixels and restore/cache checks from the first complete stock manga run. It found **14/23 anchors and 3/8 strictly passing scenes**; five scenes retain missing dialogue or a missing colored tail. Eight declared negative regions had no detections. Protected opaque pixels, original restoration and cache redisplay passed on all eight scenes. Models came from four existing cache hits, with zero downloads and zero model requests.

The baseline used the frozen V6 stock product artifact associated with head `43f99105bcb7d573df65a85494acb38312a447d8`; all 515 compiled file hashes were rechecked, and the five recorded product module hashes match that head. The build archive records its earlier c302 working state and is retained as such. The native run did not archive its runner SHA: it used actual-response empty-result handling, before the later source-visibility assertion. The archive records this gap instead of assigning a current script hash to the historical run. Earlier interrupted attempts remain in evidence and do not replace this complete baseline.

This is a failing historical baseline, not a runtime-clean or candidate pass. Its diagnostics retain one unique/two raw placement warnings and `blockerIds:[1]` because functional quality failed; bounded attachment coverage is recorded. Offscreen samples do not count separate-worker native inference: `runs:0` is not zero inference. Translation transport is deterministic test data, so there is no live-provider, linguistic-quality, CER, whole-pipeline speedup or complete text-erasure claim. Recognition and background repair require separate assessment.
