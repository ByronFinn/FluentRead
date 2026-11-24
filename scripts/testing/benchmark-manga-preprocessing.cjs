#!/usr/bin/env node
/**
 * 比较同一机器上当前工作树与指定 Git 提交的漫画 CPU 预处理，验证逐字节相等后交替计时。
 * 只隔离执行气泡定位和修补张量准备；不加载模型，不代表 OCR/翻译全流程或跨项目性能。
 * 用法：node scripts/testing/benchmark-manga-preprocessing.cjs --before-ref <commit> --out-dir <evidence-dir>
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),ts=require('typescript');
const esbuild=createRequire(require.resolve('vite'))('esbuild');
function options(argv){
 const parsed={iterations:31,warmup:10};
 for(let index=0;index<argv.length;index+=2){
  const key=argv[index],value=argv[index+1];
  if(!['--before-ref','--out-dir','--iterations','--warmup'].includes(key)||!value)throw new Error('参数无效：'+key);
  parsed[key.slice(2)]=value;
 }
 if(!parsed['before-ref']||!parsed['out-dir'])throw new Error('须指定 --before-ref 和 --out-dir');
 for(const key of ['iterations','warmup']){
  parsed[key]=Number(parsed[key]);
  if(!Number.isSafeInteger(parsed[key])||parsed[key]<1||parsed[key]>101)throw new Error('采样次数必须为1至101的整数');
 }
 return parsed;
}
const args=options(process.argv.slice(2)),folder=path.resolve(args['out-dir']);
const beforeCommit=execFileSync('git',['rev-parse','--verify',args['before-ref']+'^{commit}'],{cwd:root,encoding:'utf8'}).trim();
fs.mkdirSync(folder,{recursive:true});
const digest=values=>crypto.createHash('sha256').update(Buffer.from(values.buffer,values.byteOffset,values.byteLength)).digest('hex');
function functionSource(source,name){
 const file=ts.createSourceFile('preprocessing.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const node=file.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text===name);
 if(!node)throw new Error('缺少函数：'+name);
 return esbuild.transformSync(node.getText(file).replace(/^export\s+/,''),{loader:'ts'}).code;
}
function load(source,name,dependencies={}){
 return new Function(...Object.keys(dependencies),functionSource(source,name)+`;return ${name};`)(...Object.values(dependencies));
}
function sources(relative){
 const before=execFileSync('git',['show',beforeCommit+':'+relative],{cwd:root,encoding:'utf8'}),after=fs.readFileSync(path.join(root,relative),'utf8');
 const name=path.basename(relative);
 fs.writeFileSync(path.join(folder,name+'.before'),before);fs.writeFileSync(path.join(folder,name+'.after'),after);
 return {before,after,beforeSha256:digest(Buffer.from(before)),afterSha256:digest(Buffer.from(after))};
}
function compare(before,after,input,check){
 const expected=before(...input),actual=after(...input);check(expected,actual);
 for(let index=0;index<args.warmup;index++){before(...input);after(...input);}
 const beforeMs=[],afterMs=[];
 for(let index=0;index<args.iterations;index++){
  for(const [fn,list] of index%2?[[after,afterMs],[before,beforeMs]]:[[before,beforeMs],[after,afterMs]]){
   const start=performance.now();fn(...input);list.push(performance.now()-start);
  }
 }
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 return {equal:true,medianBeforeMs:median(beforeMs),medianAfterMs:median(afterMs),speedup:median(beforeMs)/median(afterMs),beforeMs,afterMs};
}
const patchSources=sources('src/features/image-translation/services/mangaInpainting.ts');
const maskSources=sources('src/features/image-translation/mangaPatchResult.ts');
const beforePatch=load(patchSources.before,'createMangaPatch',{maskBoxes:load(maskSources.before,'mangaMaskBoxes')});
const afterPatch=load(patchSources.after,'createMangaPatch',{maskBoxes:load(maskSources.after,'mangaMaskBoxes')});
const patchRows=[];
for(const fixture of [
 {name:'single-line',width:1000,height:1300,bbox:{x0:200,y0:300,x1:500,y1:360},lines:1},
 {name:'ten-line-dialogue',width:1000,height:1300,bbox:{x0:150,y0:180,x1:750,y1:950},lines:10},
 {name:'forty-line-dense',width:1800,height:2400,bbox:{x0:100,y0:100,x1:1600,y1:2000},lines:40},
 {name:'hundred-line-strip',width:800,height:8192,bbox:{x0:30,y0:100,x1:770,y1:8000},lines:100},
]){
 const {width,height,bbox,lines}=fixture,pixels=new Uint8ClampedArray(width*height*4),step=(bbox.y1-bbox.y0)/lines;
 for(let index=0;index<pixels.length;index++)pixels[index]=(index*37+11)%256;
 const region={text:'Benchmark',bbox,fontSize:24,sourceBoxes:Array.from({length:lines},(_,index)=>({
  x0:bbox.x0+(index%3)*7+.3,x1:bbox.x1-(index%3)*9-.4,y0:bbox.y0+index*step+.2,y1:bbox.y0+(index+.6)*step-.1}))};
 let hashes;
 const measured=compare(beforePatch,afterPatch,[pixels,width,height,region],(before,after)=>{
  hashes={imageHash:digest(after.patch.image),maskHash:digest(after.patch.mask)};
  if(digest(before.patch.image)!==hashes.imageHash||digest(before.patch.mask)!==hashes.maskHash)throw new Error('补丁不等价：'+fixture.name);
 });
 patchRows.push({...fixture,inputSha256:digest(pixels),...hashes,...measured});
}
const bubbleSources=sources('src/features/image-translation/services/mangaBubbles.ts');
patchSources.timedFunctionSha256={before:digest(Buffer.from(functionSource(patchSources.before,'createMangaPatch'))),after:digest(Buffer.from(functionSource(patchSources.after,'createMangaPatch')))};
bubbleSources.timedFunctionSha256={before:digest(Buffer.from(functionSource(bubbleSources.before,'findMangaBubbles'))),after:digest(Buffer.from(functionSource(bubbleSources.after,'findMangaBubbles')))};
const beforeBubbles=load(bubbleSources.before,'findMangaBubbles'),afterBubbles=load(bubbleSources.after,'findMangaBubbles');
function queueAllocation(source,input){
 const allocations=[];
 class MeasuredQueue extends Uint32Array{constructor(length){super(length);allocations.push(this.byteLength);}}
 load(source,'findMangaBubbles',{Uint32Array:MeasuredQueue})(...input);
 return {queueAllocationsBytes:allocations,maxQueueBytes:Math.max(...allocations),
  // 保守地连旧栈也全部保留；这是显式辅助数组分配上界，不是浏览器/RSS采样。
  auxiliaryAllocatedBytes:input[1]*input[2]+allocations.reduce((sum,bytes)=>sum+bytes,0)};
}
const bubbleRows=[];
for(const fixture of [
 {name:'closed-bubbles',width:1200,height:1800,kind:'bubbles'},
 {name:'large-white-background',width:4096,height:4096,kind:'white'},
 {name:'connected-scanlines',width:1000,height:1000,kind:'comb'},
]){
 const {width,height}=fixture,pixels=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const lit=fixture.kind==='white'||(fixture.kind==='comb'?(y%2||x%2):((x%300)>30&&(x%300)<250&&(y%300)>30&&(y%300)<200));
  if(lit)pixels.set([255,255,255,255],(y*width+x)*4);
 }
 const input=[pixels,width,height];let result;
 const measured=compare(beforeBubbles,afterBubbles,input,(before,after)=>{
  result=after;if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('气泡不等价：'+fixture.name);
 });
 bubbleRows.push({...fixture,inputSha256:digest(pixels),bubbles:result.length,
  beforeAllocation:queueAllocation(bubbleSources.before,input),afterAllocation:queueAllocation(bubbleSources.after,input),...measured});
}
const report={scope:'CPU preprocessing functions only; no model download/inference, no end-to-end or cross-project speed claim',
 timestamp:new Date().toISOString(),runtime:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,
 beforeCommit,currentHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 dirty:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}).trim(),
 iterations:args.iterations,warmup:args.warmup,sources:{patch:patchSources,bubbles:bubbleSources},patch:patchRows,bubbles:bubbleRows};
for(const value of Object.values(report.sources)){delete value.before;delete value.after;}
fs.writeFileSync(path.join(folder,'benchmark.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({patch:patchRows.map(({name,medianBeforeMs,medianAfterMs,speedup,equal})=>({name,medianBeforeMs,medianAfterMs,speedup,equal})),
 bubbles:bubbleRows.map(({name,medianBeforeMs,medianAfterMs,speedup,equal,beforeAllocation,afterAllocation})=>({name,medianBeforeMs,medianAfterMs,speedup,equal,beforeAllocation,afterAllocation}))},null,2));
