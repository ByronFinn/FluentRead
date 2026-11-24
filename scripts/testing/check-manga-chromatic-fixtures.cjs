'use strict';
// Pure frozen-input/quality-gate checker. Never runs OCR, models or browser code.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const sha=b=>createHash('sha256').update(b).digest('hex');
const {values}=require('node:util').parseArgs({options:{'repository-root':{type:'string'},'fixture-dir':{type:'string'},design:{type:'string'}},strict:true,allowPositionals:false});
const repo=path.resolve(values['repository-root']??path.join(__dirname,'../..')),dir=path.resolve(values['fixture-dir']??path.join(repo,'tests/fixtures/manga-chromatic'));
const bytes=fs.readFileSync(path.join(dir,'manifest.json')),m=JSON.parse(bytes),g=require(path.join(repo,'scripts/testing/manga-quality-corpus.cjs'));
// Independent digest from the first source freeze; never derive expected truth from the file under test.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const contentSha=value=>sha(Buffer.from(JSON.stringify(canonical(value))));
assert.equal(contentSha(m.fixtures),'4489bca5470305202e07d533bdb0e399e8bfc355b86f3328e088c3e4a42264d4','Complete pre-OCR fixture content is immutable');
const payload={...m};delete payload.generator;delete payload.generatorSha256;
assert.equal(contentSha(payload),'e03d96b352f29e32ecaf8d305175e692a70c9f3e2c9362a866f4dcd1f5fcf371','Complete pre-OCR manifest content is immutable');
const generator='scripts/testing/generate-manga-chromatic-fixtures.py',allowed={'generate-chromatic-fixtures.py':'022aacee37d2456bf11f529aa5808525bb172c0d27c140b8300a0c355f2fea2b',[generator]:sha(fs.readFileSync(path.join(repo,generator)))};
assert.equal(m.generatorSha256,allowed[m.generator],'Only the original or exact maintained generator provenance is allowed');assert.ok(Object.hasOwn(allowed,m.generator));
const design=fs.readFileSync(path.resolve(values.design??path.join(dir,'design.json')));
assert.equal(sha(design),'1287de36a49b5002a2ee1e0a2be683a685ca30db40a9efa5288e35fa605935e6');assert.equal(m.designSha256,sha(design));
assert.equal(m.fixtures.length,8);assert.equal(new Set(m.fixtures.map(f=>f.name)).size,8);
const counts={scenes:0,anchors:0,perfectTruthReplays:0,singleCharacterMisreadRejected:0,artInjectionsRejected:0,extraTextOutsideArtRejected:0,independentGroupsConflationRejected:0,coloredTailTruncationRejected:0,wordlessFalseTextRejected:0};
function perfect(f){
 const groups=f.paragraphGroups||[];const lines=groups.map(ids=>{
  const rs=ids.map(id=>f.regions.find(r=>r.id===id)),bbox={x0:Math.min(...rs.map(r=>r.bbox.x0)),y0:Math.min(...rs.map(r=>r.bbox.y0)),x1:Math.max(...rs.map(r=>r.bbox.x1)),y1:Math.max(...rs.map(r=>r.bbox.y1))},sourceText=rs.map(r=>r.text).join(' ');
  return {text:sourceText,sourceText,bbox,sourceBoxes:rs.map(r=>r.bbox)};
 });return {texts:lines.map(l=>l.sourceText),lines};
}
for(const f of m.fixtures){
 const b=fs.readFileSync(path.join(dir,f.file));assert.equal(sha(b),f.sha256);assert.equal(b.length,f.bytes);assert.equal(b.readUInt32BE(16),900);assert.equal(b.readUInt32BE(20),900);
 assert.deepEqual(f.expectedSource,f.regions.map(r=>r.text));assert.deepEqual(f.expectedAnchors,f.expectedSource);g.validateQualityFixtureExpectations(f);
 const exact=perfect(f);assert.deepEqual(g.evaluateQualityFixture(f,exact).qualityFailures,[]);assert.deepEqual(g.evaluateQualityReadingOrder(f,exact.texts).qualityFailures,[]);counts.perfectTruthReplays++;counts.scenes++;counts.anchors+=f.expectedAnchors.length;
 for(const region of f.regions){
  const actual=structuredClone(exact),line=actual.lines.find(l=>l.sourceText.includes(region.text));const wrong=(region.text.startsWith('X')?'Y':'X')+region.text.slice(1);line.sourceText=line.sourceText.replace(region.text,wrong);line.text=line.sourceText;actual.texts=actual.lines.map(l=>l.sourceText);
  assert(g.evaluateQualityFixture(f,actual).qualityFailures.some(x=>x.type==='ocr-anchor'));counts.singleCharacterMisreadRejected++;
 }
 const n=f.forbiddenRegions[0].bbox,art={text:'EXTRA NOTE',sourceText:'EXTRA NOTE',bbox:{x0:n.x0+1,y0:n.y0+1,x1:n.x0+11,y1:n.y0+11}};
 const polluted={texts:[...exact.texts,art.sourceText],lines:[...exact.lines,art]},fail=g.evaluateQualityFixture(f,polluted).qualityFailures;
 assert(fail.some(x=>x.type==='artwork-ocr-false-positive'));assert(fail.some(x=>x.type==='unexpected-ocr-characters'));counts.artInjectionsRejected++;
 if(f.expectedNoText){assert(fail.some(x=>x.type==='wordless-page-text'));counts.wordlessFalseTextRejected++;}
 else {
  const first=f.regions[0].bbox,extra={text:'ZZ',sourceText:'ZZ',bbox:first};
  assert(g.evaluateQualityFixture(f,{texts:[...exact.texts,'ZZ'],lines:[...exact.lines,extra]}).qualityFailures.some(x=>x.type==='unexpected-ocr-characters'));counts.extraTextOutsideArtRejected++;
  assert(g.evaluateQualityReadingOrder(f,[f.expectedSource.join(' ')]).qualityFailures.some(x=>x.type==='paragraph-order'));counts.independentGroupsConflationRejected++;
 }
 if(f.name==='thin-aa-gray-and-chromatic-tail'){
  const actual=structuredClone(exact);actual.lines.find(l=>l.sourceText==='KEEP THE LAST LIGHT').sourceText='KEEP';actual.texts=actual.lines.map(l=>l.sourceText);
  assert(g.evaluateQualityFixture(f,actual).qualityFailures.some(x=>x.type==='ocr-anchor'&&x.anchor==='KEEP THE LAST LIGHT'));counts.coloredTailTruncationRejected++;
 }
}
assert.equal(counts.anchors,23);assert.equal(counts.singleCharacterMisreadRejected,23);
console.log(JSON.stringify({passed:true,manifestSha256:sha(bytes),counts,scope:'PNG hashes/header dimensions, exact immutable source, public quality/order-gate perfect truth and rejected counterexamples. No OCR accuracy or pipeline performance claim.'},null,2));
