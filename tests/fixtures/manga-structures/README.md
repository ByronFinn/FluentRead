# Structural manga/image stress fixtures

Five independent original deterministic scenes,29 complete source anchors,23 declared paragraphs,8 wordless regions and11 protected pixel probes. They are a separate suite and do not change the existing32 main scenes or6 confusable controls. Source design and all PNG/fixture truth were frozen before first OCR. Full source records remain identical to the original evidence manifest SHA`fdb861632dc91ff8175ef8f5d1f7e8eb34c0c6ae67e239812bf5841367f35dd7`.

| Scene | Distinct structural pressure |
| --- | --- |
| narrow-inset-card-dialogue | Independent narrow black-framed white card inside a large speech component;18px lettering remains one complete vertical source region. |
| midband-crossing-detached-cards | Two separate cards cross the large component's conservative middle-band top/bottom boundaries. |
| bound-spread-gutter-caption | A complete heading crosses shaded book binding; left/right dialogue and small rotated spine text remain distinct. |
| multisize-margin-callouts |40px main columns,14px ruby,22px caption,18px side labels and leader lines around a plant drawing. |
| photographed-perspective-note | A whole-paper homography, deterministic desk texture/shadow and an independent upright sticky note. Programmatic photo-like geometry, not a real photograph. |

Pillow rectangle endpoints include the last pixel. The design's nominal24px coordinate difference creates25px-wide white components, still below the existing30px minimum recognition crop width. Original glyph bounds are exact and are not changed to match prose. Pure pixel measurement confirms the two card scenes have one large owner each (36.7889% and35.3010% page area); this does not prove recognition or translation success.

Rebuild only into a **new** directory:

```sh
python3 scripts/testing/generate-manga-structure-fixtures.py --out-dir /private/tmp/new-manga-structures
node scripts/testing/check-manga-structure-fixtures.cjs
```

Pillow12.3.0 and the exact font SHAs in`design.json` are required. Repeated`--font key=/local/font/path` supports alternate local paths with identical font bytes. The generator imports the maintained sibling Page helper without running the old28-scene generator. It requires all five rendered PNG hashes and the complete output manifest to equal the repository freeze before exclusive directory/file creation and rejects any existing path, including a broken symlink. Nothing is downloaded; fonts are not bundled.

For the same frozen design/helper bytes stored at another local path, explicitly pass`--design /path/design.json --page-helper /path/generate-manga-quality-fixtures.py`. The checker defaults to this repository and fixture directory. It also supports`--repository-root`,`--fixture-dir`, and`--design`, including the original evidence directory layout.

The checker pins complete canonical fixture/manifest digests from the original pre-OCR freeze before any semantic replay, permitting only the documented generator-path adaptation. It then verifies frozen design SHA, full source strings, PNG SHA/size/header, source groups and51 strict negative cases. It rejects single-character errors in every anchor, artwork detections, excess characters, conflated paragraphs and reversed source order. The CUP/PLEASE boundary counterexample shows anchor presence alone can borrow a missing character, while full paragraph matching rejects it.

The original checker SHA`662a282108bfe2ca0171e0046d666bc5a03d4e76781690bf2352eb4c6c8b2a55` was frozen against the earlier substring/group-separation helper. Repository checks now combine portable paths/CLI, fixed complete canonical fixture/manifest content digests, and the updated all-groups-conflated assertion: the new exact complete-paragraph helper must report`paragraph-order`, not the historical`paragraph-separation`. Every one of the same51 negatives still must fail. This is documented in`provenance.json`; the original script remains in evidence.

The source-only helper replay is not an OCR accuracy result. `first-ocr-baseline.json` preserves the first real stock-c302/v5 production-font run with exact paragraphGroups helper698fc68…, not a later v6 candidate:26/29 complete anchors,3 strict passes (`narrow-inset-card-dialogue`, `midband-crossing-detached-cards`, `multisize-margin-callouts`) and2 failures. The bound spread loses VOL08 and splits both intended dialogue groups; the perspective note misses title/footer and has1 excess N. Eight negative regions had0 detections; all protected pixels, original restoration and cached redisplay checks passed. Four model files were cache hits, with0 downloads/model requests. The browser/profile were cleaned up. A unique ORT warning remains blocking because quality failed; this is not a runtime-clean or all-green claim. No source PNG, text, anchor, group or box was changed after seeing results.

All wording and geometric art are original test content. System fonts are used locally by SHA only; no external comic art, font file, model or executable is distributed. Test assets do not enter the extension bundle. Old50 protected input/generator files remain unchanged. A separate author reviews repository portability; this README does not claim independent review of its own author's code.

Independent review initially found two checker bypasses: changed paragraph groups and replacing the gutter scene with a repeated photo fixture. Both are preserved in evidence and closed by fixed full-content digests;18 actual filesystem/CLI corruptions reject, with object-key reordering and the2 documented generator paths accepted. The checker never accepts a new manifest merely because its own fields agree.
