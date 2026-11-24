/**
 * 用真实回归报告的源 PNG、尺寸、识别框及背景分类对照均匀页像素所有权。
 * 从指定 Git ref 与当前源码抽取真实修补工厂及 Offscreen 拷回语句；复杂页
 * 只控制原生响应，比较输入张量/蒙版和最终 RGBA，不运行或下载模型。
 * 局部计时只覆盖修补返回与拷回，不包含 OCR、Canvas、PNG、模型或整页耗时。
 * 用法：node scripts/testing/benchmark-manga-owned-pixels.cjs --before-ref <ref>
 *   --pipeline-report <report.json> --out-dir <外部证据目录> --python <带Pillow的python>
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'../..'),ts=require('typescript'),esbuild=createRequire(require.resolve('vite'))('esbuild');
const NativePixels=Uint8ClampedArray,argv=process.argv.slice(2),args={};
for(let index=0;index<argv.length;index+=2){
 const key=argv[index],value=argv[index+1];
 if(!['--before-ref','--pipeline-report','--out-dir','--python','--iterations'].includes(key)||!value||args[key])throw new Error('参数无效：'+key);
 args[key]=value;
}
for(const key of ['--before-ref','--pipeline-report','--out-dir'])if(!args[key])throw new Error('须指定 '+key);
const iterations=Number(args['--iterations']??9);
if(!Number.isInteger(iterations)||iterations<5||iterations>51)throw new Error('iterations须为5至51的整数');
const out=path.resolve(args['--out-dir']),relativeOut=path.relative(root,out);
if(!relativeOut.startsWith('..'+path.sep)&&relativeOut!=='..')throw new Error('输出目录须位于仓库之外');
const beforeCommit=execFileSync('git',['rev-parse','--verify',args['--before-ref']+'^{commit}'],{cwd:root,encoding:'utf8'}).trim();
const source=(file,before)=>before?execFileSync('git',['show',`${beforeCommit}:${file}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const file='src/features/image-translation/services/mangaInpainting.ts',owner='src/features/image-translation/services/offscreenRuntime.ts';
function parse(text){return ts.createSourceFile('benchmark.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);}
function extract(text,name){
 const file=parse(text),node=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 if(!node)throw new Error('缺少函数：'+name);
 return node.getText(file).replace(/^export\s+/,'');
}
function ownerParts(text){
 const file=parse(text);let call,copy;
 function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(file)==='mangaInpaintingRuntime.repair')call=node;
  if(ts.isExpressionStatement(node)&&node.getText(file)==='sourcePixels.data.set(pixels);')copy=ts.isIfStatement(node.parent)?node.parent:node;
  ts.forEachChild(node,visit);
 }
 visit(file);assert(call&&copy,'缺少生产修补调用或拷回语句');
 const option=call.arguments[8]?.getText(file)??'undefined';
 return {options:new Function('return '+option)(),copySource:copy.getText(file),copy:new Function('sourcePixels','pixels',copy.getText(file))};
}
function load(before){
 const inpainting=source(file,before),rendering=source('src/features/image-translation/services/mangaRendering.ts',before);
 const core=source('src/features/image-translation/core.ts',before),result=source('src/core/translation/result.ts',before);
 const code=['hasTranslationContent','hasDistinctTranslation'].map(name=>extract(result,name)).join('\n')+'\n'
  +['normalizeTranslationComparison','selectChangedTranslations'].map(name=>extract(core,name)).join('\n')+'\n'
  +extract(source('src/features/image-translation/services/rendering.ts',before),'getImageTextBackgroundColor')+'\n'
  +extract(rendering,'mangaRegionBackground')+'\n'
  +extract(source('src/features/image-translation/mangaPatchResult.ts',before),'mangaMaskBoxes')+'\nconst maskBoxes=mangaMaskBoxes;\n'
  +['createMangaPatch','applyMangaPatch','createMangaInpaintingRuntime'].map(name=>extract(inpainting,name)).join('\n');
 const counters={allocatedBytes:0,copybackBytes:0,copybacks:0,nativeInputs:[]};
 class RecordedPixels extends NativePixels{constructor(input){super(input);counters.allocatedBytes+=this.byteLength;}}
 const exports=new Function('Uint8ClampedArray','withMangaModelAdmission','assertMangaOcrActive',esbuild.transformSync(code,{loader:'ts'}).code+';return {createMangaInpaintingRuntime,mangaRegionBackground,selectChangedTranslations};')(
  RecordedPixels,operation=>operation(),signal=>{if(signal?.aborted)throw new DOMException('取消','AbortError');});
 // 使用真实选行契约，品牌大小写、标点或无内容译文不应凭空产生复制收益。
 const line={text:'Brand',bbox:{x0:1,y0:2,x1:30,y1:20}};
 for(const translation of ['BRAND','Brand!','Brand\u200b','',undefined])assert.deepEqual(exports.selectChangedTranslations([line],[translation]),[]);
 assert.deepEqual(exports.selectChangedTranslations([line],['  新译文  ']),[{...line,text:'新译文'}]);
 const port={async run(patch){counters.nativeInputs.push(hash(Buffer.concat([Buffer.from(`${patch.width}x${patch.height}:`),Buffer.from(patch.image.buffer),Buffer.from(patch.mask.buffer)])));return new Float32Array(patch.image.length).fill(.25);},async release(){}};
 return {before,source:inpainting,owner:source(owner,before),rendering,core,result,select:exports.selectChangedTranslations,ownerParts:ownerParts(source(owner,before)),runtime:exports.createMangaInpaintingRuntime(async()=>port),background:exports.mangaRegionBackground,counters};
}
function decode(file){
 const bytes=execFileSync(args['--python']??'python3',['-c','from PIL import Image\nimport sys,struct\nim=Image.open(sys.argv[1]).convert("RGBA")\nsys.stdout.buffer.write(struct.pack("<II",*im.size)+im.tobytes())',file],{maxBuffer:128*1024*1024});
 const width=bytes.readUInt32LE(0),height=bytes.readUInt32LE(4);
 return {width,height,pixels:new NativePixels(bytes.buffer,bytes.byteOffset+8,bytes.byteLength-8)};
}
async function run(version,image,regions,backgrounds,timing=false){
 const input=new NativePixels(image.pixels),nativeStart=version.counters.nativeInputs.length;
 const count={allocatedBefore:version.counters.allocatedBytes,copybacksBefore:version.counters.copybacks,copyBytesBefore:version.counters.copybackBytes};
 const set=input.set.bind(input);input.set=(pixels,...rest)=>{version.counters.copybacks++;version.counters.copybackBytes+=pixels.byteLength;return set(pixels,...rest);};
 const start=performance.now();
 const output=await version.runtime.repair(input,image.width,image.height,regions,undefined,undefined,undefined,backgrounds,version.ownerParts.options);
 version.ownerParts.copy({data:input},output);const ms=performance.now()-start;
 return {ms,outputHash:timing?undefined:hash(input),sameView:output===input,allocatedBytes:version.counters.allocatedBytes-count.allocatedBefore,copybacks:version.counters.copybacks-count.copybacksBefore,copybackBytes:version.counters.copybackBytes-count.copyBytesBefore,nativeInputs:version.counters.nativeInputs.slice(nativeStart)};
}
(async()=>{
 const pipelinePath=path.resolve(args['--pipeline-report']),pipeline=JSON.parse(fs.readFileSync(pipelinePath,'utf8')).pipeline;
 assert(Array.isArray(pipeline)&&pipeline.length>0,'须提供实际pipeline报告');
 const versions=[load(true),load(false)],cases=[],selectionChecks=[];
 try{for(const row of pipeline){
  const original=row.ocrLines.map(line=>({...line,text:line.sourceText})),translations=row.ocrLines.map(line=>line.text);
  const selected=versions.map(version=>version.select(original,translations)),regions=selected[0];
  assert.deepEqual(selected[0],selected[1],'变更行筛选必须等价');
  const previous=row.ocrLines.filter(line=>line.text.trim()!==line.sourceText.trim());
  selectionChecks.push({scene:row.scene,regions:regions.length,previousRegions:previous.length,previousSelectionEqual:JSON.stringify(previous)===JSON.stringify(regions)});
  const image=decode(row.input);
  const backgrounds=versions.map(version=>regions.map(region=>version.background(image.pixels,image.width,image.height,region.bbox)));
  assert.deepEqual(backgrounds[0],backgrounds[1],'原图分类必须等价');
  // 无字页在Offscreen进入repair之前返回，不能把不存在的复制计入收益。
  if(!regions.length){cases.push({scene:row.scene,width:image.width,height:image.height,skipped:'No changed translation regions; production does not allocate ImageData or call repair.'});continue;}
  const observed=[];for(let index=0;index<2;index++)observed.push(await run(versions[index],image,regions,backgrounds[index]));
  assert.equal(observed[0].outputHash,observed[1].outputHash,'最终RGBA必须相同');assert.deepEqual(observed[0].nativeInputs,observed[1].nativeInputs,'原生图像/蒙版必须相同');
  const uniform=backgrounds[0].every(background=>background.uniform===true),bytes=image.pixels.byteLength;
  assert.equal(observed[0].allocatedBytes,bytes);assert.equal(observed[0].copybackBytes,bytes);
  assert.equal(observed[1].allocatedBytes,uniform?0:bytes);assert.equal(observed[1].copybackBytes,uniform?0:bytes);assert.equal(observed[1].sameView,uniform);
  const timings=[[],[]];
  if(uniform)for(let iteration=0;iteration<iterations+2;iteration++)for(const index of iteration%2?[1,0]:[0,1]){
   const result=await run(versions[index],image,regions,backgrounds[index],true);assert.equal(result.nativeInputs.length,0);
   if(iteration>=2)timings[index].push(result.ms);
  }
  cases.push({scene:row.scene,width:image.width,height:image.height,rgbaBytes:bytes,sourceSha256:hash(fs.readFileSync(row.input)),regions:regions.length,uniformRegions:backgrounds[0].filter(b=>b.uniform).length,modelRegions:backgrounds[0].filter(b=>!b.uniform).length,uniform,before:observed[0],after:observed[1],localCopyTiming:uniform?{iterations,beforeMedianMs:median(timings[0]),afterMedianMs:median(timings[1]),beforeMs:timings[0],afterMs:timings[1]}:null});
 }}finally{await Promise.all(versions.map(version=>version.runtime.dispose()));}
 const uniform=cases.filter(row=>row.uniform),all=cases.filter(row=>!row.skipped);
 const report={at:new Date().toISOString(),beforeCommit,pipelineReport:pipelinePath,pipelineReportSha256:hash(fs.readFileSync(pipelinePath)),source:versions.map(v=>({version:v.before?'before':'after',inpaintingSha256:hash(v.source),ownerSha256:hash(v.owner),renderingSha256:hash(v.rendering),selectorCoreSha256:hash(v.core),selectorResultSha256:hash(v.result),callOptions:v.ownerParts.options,copySource:v.ownerParts.copySource})),scope:'Actual source PNGs, production changed-translation selector, detected regions and classification; production repair factory plus exact production Offscreen copyback statement. Controlled native response; local repair-return/copyback timing only.',selectorContract:{casesPerVersion:6,beforeAfterEqual:true,selectionChecks},cases,summary:{scenes:cases.length,changedPages:all.length,uniformPages:uniform.length,modelRunsEach:all.reduce((n,r)=>n+r.before.nativeInputs.length,0),uniformAllocationBytesRemoved:uniform.reduce((n,r)=>n+r.before.allocatedBytes-r.after.allocatedBytes,0),uniformWholeArrayCopyBytesRemoved:uniform.reduce((n,r)=>n+r.before.allocatedBytes+r.before.copybackBytes-r.after.allocatedBytes-r.after.copybackBytes,0),maximumSinglePageAllocationBytesRemoved:Math.max(0,...uniform.map(r=>r.rgbaBytes)),sumLocalBeforeMedianMs:uniform.reduce((n,r)=>n+r.localCopyTiming.beforeMedianMs,0),sumLocalAfterMedianMs:uniform.reduce((n,r)=>n+r.localCopyTiming.afterMedianMs,0),allNativeInputsAndOutputPixelsEqual:true},limits:['No browser, native model, OCR, Canvas drawing/PNG encoding or end-to-end latency is measured.','Pixel equality plus unchanged drawing code is the deterministic prerequisite; final actual browser output regression remains separate.','The real model-removal admission is tested separately; this benchmark has no removal in progress and delegates admission directly.','Totals of removed allocations/copies are cumulative across these pages, not aggregate process memory or measured peak RSS.','Same-page complex source context, model inputs, masks and output pixels remain unchanged; global budgets and cancellation are not tuned.']};
 fs.mkdirSync(out,{recursive:true});for(const version of versions){const prefix=version.before?'before':'after';fs.writeFileSync(path.join(out,prefix+'-mangaInpainting.ts'),version.source);fs.writeFileSync(path.join(out,prefix+'-copyback.js'),version.ownerParts.copySource+'\n');}
 fs.writeFileSync(path.join(out,'owned-pixels.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
