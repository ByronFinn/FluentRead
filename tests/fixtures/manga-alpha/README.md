# Original alpha and paragraph-structure fixtures

Six deterministic RGBA images contain 29 complete source anchors and 20 explicitly independent paragraph groups. The design froze before any OCR on 2026-10-25 at13:42:24 UTC. No image was selected, rewritten, or relaxed in response to OCR. The existing51 inputs, their truth, the runner, and test-matrix registration are unchanged. This is a separate suite; it is not yet evidence of OCR or rendering success.

The first real baseline used the previously frozen V8 production build at `0c58cb656be810441a6db3c4a35bd8d41b1bea35`, whose ten pinned image modules match the V9 base. It recognized26/29 anchors and passed0/6 strict scenes. The dock holes produced two extra `I` characters; the atlas spine became `N D EX 0 0` instead of `INDEX 09`, with an erroneous746,148–844,1024 source box. That box erased the protected spine pixel at800,1010 from RGB60/56/50 to245/240/217, so the run stopped with the artwork-protection assertion and no final quality summary; atlas restore/cache checks were not reached. Every original source string, group, PNG and protection point remains unchanged. The44-test corpus CI result validates frozen inputs and rejection gates, not successful OCR. The full failed run remains in `iteration-v9-recognition/baseline-alpha6/` evidence.

| Scene | Anchors / groups | Main distinction |
| --- | --- | --- |
| transparent-lantern-bridge-balloons |4 /2| English and Japanese pale translucent speech balloons coexist with a bridge illustration over true transparent space. |
| translucent-riverside-notice |4 /3| A156/255-alpha white notice is composited over an original grain/hue-gradient market scene and the edge of its awnings; title, body and platform label stay independent. |
| perforated-alpha-dock-note |3 /2| Alpha0 and96 interword holes lie inside complete physical source-text bounding boxes without removing any source glyph. |
| same-tone-cabin-controls |5 /4| A wrapped instruction and independent status labels share the same continuous dark background, typeface and baseline spacing. |
| inverse-neighbor-tidal-balloons |5 /3| Adjacent black/white balloons retain separate speakers above translucent water illustration and an independent caption. |
| bound-atlas-rule-and-inset-card |8 /6| Two semitransparent cream pages have a cross-spine title, separate columns, a one-pixel rule, an inset card and a rotated spine index. |

`design.json` pins every complete source string, style, position, paragraph role, font hash and Pillow version. `manifest.json` records actual glyph bounding boxes, exact occurrences, wordless-art negative regions, three opaque protection pixels per page, additional RGBA probes, decoded-RGBA/PNG hashes and source-alpha counts. A visual contact sheet and author verification are in the task's `iteration-v9-recognition/alpha-corpus/` evidence directory. Text has been visually inspected; the small rotated index and hard paragraph cases remain strict truth even if a model later misses them.

Transparency boundaries matter. `protectedProbes` retains the existing opaque RGB contract. `protectedAlphaProbes` and `sourceAlphaHoles` are additional source truth; the current shared browser harness does not validate these extra fields. The notice's translucent white layer is composited over an opaque background, so its interior output alpha is255. The cabin panel is an opaque control. Other pages retain partial source alpha. The dock holes are6×18px, one at alpha0 and one at96, with zero glyph-mask coverage; their full RGBA values must be evaluated explicitly in a future rendering test. They do not establish that a production OCR patch will cover those holes, or that inpainting can recover exact RGB under a mask.

The transparent-balloon page's four frozen alpha probes all land in transparent space and therefore do not directly sample its208/224-alpha balloon interiors. Its complete source RGBA hash and alpha counts still bind those interiors, but neither those hashes nor the25 source probe declarations prove that a translated patch preserved them. Actual patch coverage and translated-RGBA checks are a separate acceptance requirement; no probe or truth is adjusted after the observed baseline failure.

The first actual baseline/candidate PNG comparison leaves both dock-hole probe locations at alpha255. Both points lie inside new translated-text bounding boxes, so those output samples do not isolate repair from background filling or intended translated ink, and they do not demonstrate hole preservation. Across25 declared probes,23 alpha values and21 raw RGBA values match source in both runs; the other two raw-RGB differences are one-unit atlas Canvas roundtrip quantization with unchanged alpha. These observations are not an OCR, rendering-success or improvement score.

Rebuild using an installed Pillow12.3.0 runtime and the exact external font files:

```sh
python3 scripts/testing/generate-manga-alpha-fixtures.py --out-dir /tmp/fluentread-manga-alpha-new
```

The output path must not exist. The generator validates all six pages, complete frozen metadata, exact fonts, design and pixel hashes before creating the directory, then writes exclusively. `--design` supports an explicit copy of the identical design. Repeatable `--font key=/local/path` overrides accept only the same frozen font SHA. Maximum dimensions are1600×1200, at most1.92MP per scene and12MP per suite; these six use8.16MP and567,339 PNG bytes.

The design SHA is `0a576bb798af2ae15632ac9a3e1576fe9dfc84c35e34756e4f01efd48afd5de7`; manifest SHA is `d5067fdf9438ff253c2124aaf665094f67ac5361847c56ccabfe806cded10060`. Complete fixture-object and manifest-content digests are fixed in the generator, so editing a source label, paragraph group, box, artwork or PNG cannot silently become a new expectation. The first evidence freeze and two fresh rebuilds are byte-identical.

All artwork and text are original deterministic test material. No AI image, external artwork, model weights or font files are bundled. System fonts remain external local inputs identified by SHA; their licenses are not changed by this fixture collection. `provenance.json` records the source freeze. No OCR accuracy, live-provider/site/device coverage, latency or pipeline speedup is claimed.
