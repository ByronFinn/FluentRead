/** Verify frozen source integrity and strict quality counterexamples without models or browser. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');const root=path.resolve(__dirname,'../..');
const helper=path.join(root,'scripts/testing/manga-quality-corpus.cjs'),{validateQualityFixtureExpectations,evaluateQualityFixture}=require(helper),p=path.join(root,'tests/fixtures/manga-confusables'),m=JSON.parse(fs.readFileSync(path.join(p,'manifest.json')));const observations=[];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const designBytes=fs.readFileSync(path.join(p,'design.json')),design=JSON.parse(designBytes);
assert.equal(sha(designBytes),'7af332554f08681a25768616c192d912bbaf25582f7a48270f834c695facd0fa','Pre-first-OCR design is frozen');
assert.equal(m.designSha256,sha(designBytes));assert.equal(m.fixtures.length,6);
const baseline=JSON.parse(fs.readFileSync(path.join(p,'first-ocr-baseline.json')));
assert.equal(baseline.sourceBeforeAnyOcr,true);assert.equal(baseline.sourceDesignSha256,m.designSha256);
assert.equal(baseline.newSix.strictPass,false);assert.equal(baseline.newSix.fullAnchorsFound,12);
assert.deepEqual(baseline.newSix.scenes.map(scene=>scene.scene),m.fixtures.map(fixture=>fixture.name));
assert.deepEqual(baseline.newSix.scenes.filter(scene=>scene.qualityFailures.length).map(scene=>scene.scene),['ja-clear-management-tags','ja-split-font-reference-tags']);
for(const f of m.fixtures){
 assert(['en','ja','ko','ru','auto'].includes(f.sourceLanguage));validateQualityFixtureExpectations(f);
 assert.deepEqual(f.expectedSource,design.scenes.find(scene=>scene.name===f.name).lines);assert.equal(f.provenance.designSha256,m.designSha256);assert.equal(f.expectedSource.length,2);assert.deepEqual(f.expectedSource,f.expectedAnchors);assert.deepEqual(f.expectedSource,f.regions.map(r=>r.text));
 const png=fs.readFileSync(path.join(p,f.file));assert.equal(sha(png),f.sha256);assert.equal(png.length,f.bytes);assert.equal(png.readUInt32BE(16),f.width);assert.equal(png.readUInt32BE(20),f.height);
 const make=(source,index)=>({sourceText:source,text:'controlled translation',bbox:f.regions[index].bbox});const run=source=>evaluateQualityFixture(f,{texts:source,lines:source.map(make)}),perfect=run(f.expectedSource);assert.deepEqual(perfect.qualityFailures,[]);
 const entry={scene:f.name,perfectTruthPass:true,mutations:[]};
 function reject(label,actual){const result=run(actual);assert(result.qualityFailures.some(v=>v.type==='ocr-anchor'||v.type==='duplicate-anchor'),f.name+' '+label);entry.mutations.push({label,failedTypes:result.qualityFailures.map(v=>v.type)});return result;}
 const toDigits=f.expectedSource.map(t=>t.replace(/\bOT\b/gu,'07'));assert.notDeepEqual(toDigits,f.expectedSource);reject('Never blanket-replace true OT with 07',toDigits);
 if(f.expectedSource.some(t=>/\bOO\b/u.test(t)))reject('True OO cannot become 00',f.expectedSource.map(t=>t.replace(/\bOO\b/gu,'00')));
 if(f.expectedSource.some(t=>/\bIT\b/u.test(t)))reject('True IT cannot become 17',f.expectedSource.map(t=>t.replace(/\bIT\b/gu,'17')));
 if(f.expectedSource.some(t=>/\b07\b/u.test(t)))reject('True 07 cannot become OT',f.expectedSource.map(t=>t.replace(/\b07\b/gu,'OT')));
 for(const [a,b] of [['O0','0O'],['0O','O0']])if(f.expectedSource.some(t=>t.includes(a))){const result=reject('Same-inventory mixed-ID sequence swap '+a+'→'+b,f.expectedSource.map(t=>t.replace(a,b)));assert.deepEqual(result.sourceCharacterInventory.excess,[]);}
 const art=evaluateQualityFixture(f,{texts:f.expectedSource,lines:[...f.expectedSource.map(make),{sourceText:'X',text:'controlled false positive',bbox:f.forbiddenRegions[0].bbox}]});assert(art.anchors.every(v=>v.found));assert(art.qualityFailures.some(v=>v.type==='artwork-ocr-false-positive'));assert(art.qualityFailures.some(v=>v.type==='unexpected-ocr-characters'));
 const extra=evaluateQualityFixture(f,{texts:f.expectedSource,lines:[...f.expectedSource.map(make),{sourceText:'X',text:'controlled extra character',bbox:f.regions[0].bbox}]});assert(extra.anchors.every(v=>v.found));assert.equal(extra.negativeDetections.length,0);assert(extra.qualityFailures.some(v=>v.type==='unexpected-ocr-characters'));
 entry.correctAnchorsDoNotHideArtworkOrExtraSourceChars=true;observations.push(entry);
}
const report={scenes:6,fullSourceAnchors:12,negativeRegions:6,perfectTruthAllPass:true,allMutationsRejected:true,observations};console.log(JSON.stringify(report,null,2));
