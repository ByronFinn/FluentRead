'use strict';
// Source integrity and strict helper-contract replay only; not a model/linguistic evaluation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {values}=require('node:util').parseArgs({options:{'repository-root':{type:'string'},'fixture-dir':{type:'string'},design:{type:'string'}},strict:true,allowPositionals:false});
const repo=path.resolve(values['repository-root']??path.join(__dirname,'../..')),root=path.resolve(values['fixture-dir']??path.join(repo,'tests/fixtures/manga-structures')),manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))),designBytes=fs.readFileSync(path.resolve(values.design??path.join(root,'design.json'))),design=JSON.parse(designBytes);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),{validateQualityFixtureExpectations,evaluateQualityFixture,evaluateQualityReadingOrder}=require(path.join(repo,'scripts/testing/manga-quality-corpus.cjs'));
// Pin content from the immutable pre-first-OCR manifest, independently of the manifest being checked.
// Object key order may change; source/scene/group arrays, every value and every PNG digest may not.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const contentSha=value=>sha(Buffer.from(JSON.stringify(canonical(value))));
assert(['generate-structure-fixtures.py','scripts/testing/generate-manga-structure-fixtures.py'].includes(manifest.generator),'Only the documented portable generator path is permitted');
assert.equal(contentSha(manifest.fixtures),'5631dffc2b25a8bcfab4ea6b8b55eaf34a9888f32b0b7fa8f4d72755eaf2056f','Frozen complete source fixture content cannot change');
assert.equal(contentSha({...manifest,generator:'scripts/testing/generate-manga-structure-fixtures.py'}),'180c17a1b18eec4a3b89c8aed32258ab032ec54bc40811dd98c0bc7ca2618f7d','Frozen full manifest content cannot change');
assert.equal(sha(designBytes),'04801c1cc084412785d426ba635d6bda286988c3d3fd4f6ca3272dae53393530','Pre-first-OCR design is frozen');assert.equal(manifest.designSha256,sha(designBytes));assert.equal(manifest.fixtures.length,5);assert.equal(design.beforeAnyOcr,true);
let anchors=0,negativeCases=0;const scenes=[];
for(const fixture of manifest.fixtures){
 validateQualityFixtureExpectations(fixture);const planned=design.scenes.find(s=>s.name===fixture.name);assert(planned);assert.deepEqual(fixture.expectedSource,planned.regions.map(r=>r.text));assert.deepEqual(fixture.expectedAnchors,fixture.expectedSource);
 const png=fs.readFileSync(path.join(root,fixture.file));assert.equal(sha(png),fixture.sha256);assert.equal(png.length,fixture.bytes);assert.equal(png.readUInt32BE(16),fixture.width);assert.equal(png.readUInt32BE(20),fixture.height);anchors+=fixture.regions.length;
 const byId=new Map(fixture.regions.map(r=>[r.id,r]));assert.equal(byId.size,fixture.regions.length);
 assert.deepEqual(fixture.paragraphGroups.flat().slice().sort(),fixture.regions.map(r=>r.id).sort());
 const lines=fixture.regions.map(r=>({sourceText:r.text,text:'controlled translation',bbox:r.bbox})),paragraphs=fixture.paragraphGroups.map(group=>group.map(id=>byId.get(id).text).join(' '));
 function evaluate(texts,actualLines=lines){return [...evaluateQualityFixture(fixture,{texts,lines:actualLines}).qualityFailures,...evaluateQualityReadingOrder(fixture,texts).qualityFailures];}
 assert.deepEqual(evaluate(paragraphs),[],fixture.name+' perfect full-source replay');
 // Every complete source anchor remains mandatory, including18px cards and14px ruby.
 for(const region of fixture.regions){
  const at=Math.floor(region.text.length/2),badText=region.text.slice(0,at)+'X'+region.text.slice(at+1),badLines=lines.map((line,i)=>fixture.regions[i]===region?{...line,sourceText:badText}:line),badParagraphs=fixture.paragraphGroups.map(group=>group.map(id=>id===region.id?badText:byId.get(id).text).join(' '));
  assert(evaluate(badParagraphs,badLines).some(f=>f.type==='ocr-anchor'),fixture.name+' must reject missing/changed '+region.id);negativeCases++;
 }
 const art=evaluate(paragraphs,[...lines,{sourceText:'X',text:'false artwork detection',bbox:fixture.forbiddenRegions[0].bbox}]);assert(art.some(f=>f.type==='artwork-ocr-false-positive'));assert(art.some(f=>f.type==='unexpected-ocr-characters'));negativeCases++;
 const extra=evaluate(paragraphs,[...lines,{sourceText:'X',text:'extra source',bbox:fixture.regions[0].bbox}]);assert(extra.some(f=>f.type==='unexpected-ocr-characters'));assert(!extra.some(f=>f.type==='artwork-ocr-false-positive'));negativeCases++;
 const merged=evaluateQualityReadingOrder(fixture,[paragraphs.join(' ')]);assert(merged.qualityFailures.some(f=>f.type==='paragraph-order'));negativeCases++;
 let reverseChecks=0;
 for(const [index,group] of fixture.paragraphGroups.entries())if(group.length>1){
  const reversed=paragraphs.slice();reversed[index]=group.slice().reverse().map(id=>byId.get(id).text).join(' ');assert(evaluateQualityReadingOrder(fixture,reversed).qualityFailures.some(f=>f.type==='paragraph-order'));reverseChecks++;negativeCases++;
 }
 if(fixture.name==='photographed-perspective-note'){const borrowed=paragraphs.map(t=>t.replace('PLEASE RETURN','LEASE RETURN'));const actual=evaluateQualityFixture(fixture,{texts:borrowed,lines:lines.map(line=>({...line,sourceText:line.sourceText.replace('PLEASE RETURN','LEASE RETURN')}))});assert(actual.anchors.every(a=>a.found));assert(evaluateQualityReadingOrder(fixture,borrowed).qualityFailures.some(f=>f.type==='paragraph-order'));negativeCases++;}
 scenes.push({scene:fixture.name,anchors:fixture.regions.length,independentParagraphs:fixture.paragraphGroups.length,perfectSourceReplay:true,allAnchorsMandatory:true,conflatedGroupsRejected:true,orderMutationsRejected:reverseChecks,artAndExtraSourceRejected:true});
}
assert.equal(anchors,29);assert.equal(negativeCases,51);
console.log(JSON.stringify({scenes:5,fullSourceAnchors:anchors,negativeCases,allAssertionsPassed:true,scope:'Frozen deterministic source/PNG/quality-helper contract; no model inference or accuracy claim.',results:scenes},null,2));
