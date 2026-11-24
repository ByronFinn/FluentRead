这六页是独立的真假字母/混码回归输入，不并入主 32 景，不改变其上限。所有图为 Pillow 程序生成的原创文字与几何画面；只放在 tests/，没有生产 import，不随扩展打包，也不包含字体或模型文件。

源设计在第一次 OCR 前冻结：design.json 的 SHA-256 为 `7af332554f08681a25768616c192d912bbaf25582f7a48270f834c695facd0fa`，原始输入 manifest 为 `8c405d8e7482ae966f82c2ff1489414f0238be689cc8b158fa33a391a93138b7`。本目录 manifest 仅调整便携生成器和字体元数据，六 PNG、逐行真值、坐标、字体/字号、模糊、负区与保护点保持一致。不要根据 OCR 输出改字、调参数、筛图或放宽预期。

| 场景 | 字号 / blur | 冻结源文字 |
| --- | --- | --- |
| ja-clear-management-tags | CJK44 / .25 | 管理メモ NOTE OT；予備の箱 CODE OO |
| ja-soft-instruction-tags | CJK36 / .65 | 次の作業 NOTE OT；確認して CHECK IT |
| ja-soft-inventory-tags | CJK40 / .85 | 在庫記録 NOTE OT；照合記号 O0 I1 Z2 S5 T7 B8 |
| ja-split-font-reference-tags | CJK40 + Courier42 / .55 | 記録カード NOTE OT 保管済み；照合番号 0O 1I 2Z 5S 7T 8B |
| ja-small-long-preservation-tags | CJK30 / .9 | 確認メモ NOTE OT 番号は変更しない；予備のラベル CODE OO CHECK IT |
| ja-paired-true-ot-digit07 | CJK44 / .8 | 読書メモ NOTE OT；読書メモ NOTE 07 |

每图1600×1000，两条完整源行，共12锚点、6无字负区、12源像素保护点。文本位置固定为 (145,235)/(145,565)；字体描边及模糊后的精确外框见 manifest。设计文件中 rejected* 路径是首次源作者检查的历史证据标识，不是重建依赖：锁定字体缺少拟用简体字时，在任何 OCR 前改成了支持的日文库存文案。未送入 OCR 的草稿和修订理由保存在原任务证据，最终六图未按模型结果筛选。

使用现有 Pillow 12.3.0 重建，不下载依赖、字体或模型：

```sh
python3 scripts/testing/generate-manga-confusable-fixtures.py \
  --out-dir /private/tmp/fluentread-confusable-rebuild
```

生成器通过同仓库 generate-manga-quality-fixtures.py 导入 Page helper，不复制快照、不执行主28景生成函数。macOS 默认使用设计中的字体路径；其他路径通过下面参数传入，必须匹配冻结 SHA，否则写文件前失败。字体不允许自动替换。不同平台的 FreeType/文字布局构建也可能产生像素差异；生成器在写入每张 PNG 前与仓库冻结像素及全部源元数据比较，不符就失败，不能更新图片来适配识别结果。

```sh
python3 scripts/testing/generate-manga-confusable-fixtures.py \
  --out-dir /private/tmp/fluentread-confusable-rebuild \
  --japanese-font /path/to/Hiragino-W4.ttc \
  --monospace-font /path/to/Courier-New.ttf
```

Hiragino W4 SHA 为 `cf8cf2c882e1e344ac2e6207fe172657a30dc2c6e1ee65a9e29a7b582c4d4154`，Courier New 为 `c886ca3172d8ce9189976992d145ec090500a4ff516ecb9d4df56b1a78336247`。只使用已有且有权使用的相同字体文件；非 macOS 可直接运行下面的 Node 输入校验，不需要字体或 Pillow。

```sh
node scripts/testing/check-manga-confusable-fixtures.cjs
```

校验使用真实质量 helper：核对 PNG SHA/尺寸及冻结设计，完美真值须通过；OT→07、OO→00、IT→17、07→OT、字符库存不变的混码交换、多余文字及负区假字均须失败。这是门禁反例回放，不是实际 OCR 成功证明。

真实浏览器可单独跑6景，复用现有共享模型缓存，不与主32景合并；所需隔离浏览器、Playwright与运行时诊断配置沿用项目漫画浏览器专项。下面仅展示六景入口参数，执行时仍须套用项目要求的运行时诊断包装器，原始 runner 不能替代完整告警采集。两个环境变量应指向现有依赖和不抢焦点 helper：

```sh
node scripts/testing/run-manga-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --quality-manifest tests/fixtures/manga-confusables/manifest.json \
  --pipeline-rounds 1 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FLUENTREAD_FOCUS_SAFE_HELPER" \
  --artifacts-dir /private/tmp/fluentread-confusable-browser
```

first-ocr-baseline.json 完整保留首次旧 v3 观察副本的六页最终源文字、两视图结果和严格失败；完整原始事件另以 SHA 标识。**新六页12/12锚点存在，但严格质量未通过**：clear 和 split 页有重复源文字，字符库存门禁失败。加上旧 mixed 参考的七景为16/17锚点、exit1；原 mixed 最终仍误认 NOTE OT。5条低置信真OT实际进入两视图，均保留OT；混码的白边视图会把 O0 I1 读成00 11，另一行0O→00时错误置信度还提高。真OO/IT行仍高置信未入选，低置信OO/IT尚未覆盖。观察规则每页最多2行/128步，两视图扣减既有4框预算，始终不替换返回结果；逐调用前后相等不等于另一次无观察者整页A/B。

首次运行固定缓存237406681 bytes、0模型下载/0模型网络请求，负区检测0，保护像素、恢复与缓存重显均通过。标准日志0 errors/0 warnings，Worker有1条去重后的ORT mixed-provider warning（2原始观测），因质量失败未当advisory忽略，runtime仍false；浏览器和临时profile已关闭。该历史基线不代表当前生产编译产物通过，也不足以批准通用双视图替换规则。
