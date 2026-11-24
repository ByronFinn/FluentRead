/**
 * 漫画修补排队操作对照：从指定 Git 提交与当前源码加载真实修补工厂，
 * 控制原生模型响应边界，检查无模型页能否在其他页的响应之前完成。
 * 不下载或运行模型，不启动浏览器，不把人为控制的等待换算为实际速度收益。
 * 用法：node scripts/testing/benchmark-manga-repair-queue.cjs --before-ref <ref> --out-dir <外部证据目录>
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),ts=require('typescript'),esbuild=createRequire(require.resolve('vite'))('esbuild');
const argv=process.argv.slice(2),args={};
for(let index=0;index<argv.length;index+=2){
 const key=argv[index],value=argv[index+1];
 if(!['--before-ref','--out-dir'].includes(key)||!value||args[key])throw new Error('参数无效：'+key);
 args[key]=value;
}
if(!args['--before-ref']||!args['--out-dir'])throw new Error('须指定 --before-ref 与 --out-dir');
const beforeCommit=execFileSync('git',['rev-parse','--verify',args['--before-ref']+'^{commit}'],{cwd:root,encoding:'utf8'}).trim();
const relative='src/features/image-translation/services/mangaInpainting.ts',maskRelative='src/features/image-translation/mangaPatchResult.ts';
const source=(file,before)=>before?execFileSync('git',['show',`${beforeCommit}:${file}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function extract(text,name){
 const file=ts.createSourceFile('queue.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const node=file.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text===name);
 if(!node)throw new Error('缺少函数：'+name);
 return node.getText(file).replace(/^export\s+/,'');
}
function load(text,mask){
 const code=extract(mask,'mangaMaskBoxes')+'\nconst maskBoxes=mangaMaskBoxes;\n'
  +['createMangaPatch','applyMangaPatch','createMangaInpaintingRuntime'].map(name=>extract(text,name)).join('\n');
 const dependencies={
  withMangaModelAdmission:operation=>operation(),
  assertMangaOcrActive:signal=>{if(signal?.aborted)throw new DOMException('漫画识别已取消','AbortError');},
  mangaRegionBackground:()=>{throw new Error('本对照传入完整原图分类，不得重新采样');},
 };
 return new Function(...Object.keys(dependencies),esbuild.transformSync(code,{loader:'ts'}).code+';return createMangaInpaintingRuntime;')(...Object.values(dependencies));
}
const flush=async()=>{for(let index=0;index<30;index++)await Promise.resolve();};
async function observe(factory){
 let releaseNative;const gate=new Promise(resolve=>{releaseNative=resolve;}),events=[],nativeInputHashes=[],complexResultHashes=[];
 const pixels=new Uint8ClampedArray(1000*1400*4).fill(255),region={text:'unchanged geometry',fontSize:20,bbox:{x0:30,y0:30,x1:90,y1:70}};
 let nativeRuns=0,uniformCompleted=false,uniformOutput;
 const port={async run(patch){nativeRuns++;nativeInputHashes.push(hash(Buffer.concat([Buffer.from(`${patch.width}x${patch.height}:`),Buffer.from(patch.image.buffer),Buffer.from(patch.mask.buffer)])));events.push('native-start-'+nativeRuns);await gate;events.push('native-response-'+nativeRuns);return new Float32Array(patch.width*patch.height*3);},async release(){events.push('release');}};
 const runtime=factory(async()=>port),background=uniform=>[{color:'rgb(255,255,255)',uniform}];
 const first=runtime.repair(pixels,1000,1400,[region],undefined,undefined,undefined,background(false)).then(result=>{complexResultHashes.push(hash(result));events.push('complex-first-complete');});
 await flush();assert.equal(nativeRuns,1);
 const second=runtime.repair(pixels,1000,1400,[region],undefined,undefined,undefined,background(true)).then(output=>{uniformCompleted=true;uniformOutput=output;events.push('uniform-complete');});
 const third=runtime.repair(pixels,1000,1400,[region],undefined,undefined,undefined,background(false)).then(result=>{complexResultHashes.push(hash(result));events.push('complex-last-complete');});
 let completedBeforeNativeResponse;
 try {await flush();completedBeforeNativeResponse=uniformCompleted;assert.equal(nativeRuns,1);}
 finally {releaseNative();await Promise.all([first,second,third]);await runtime.dispose();}
 assert.deepEqual(uniformOutput,pixels);assert.notEqual(uniformOutput,pixels);assert.equal(nativeRuns,2);
 assert(events.indexOf('complex-first-complete')<events.indexOf('complex-last-complete'));
 return {uniformCompletedBeforeNativeResponse:completedBeforeNativeResponse,nativeRuns,nativeInputHashes,complexResultHashes,complexFifo:true,uniformPixelsEqual:true,independentUniformBuffer:true,events};
}
(async()=>{
 const beforeSource=source(relative,true),afterSource=source(relative,false);
 const before=await observe(load(beforeSource,source(maskRelative,true))),after=await observe(load(afterSource,source(maskRelative,false)));
 assert.equal(before.uniformCompletedBeforeNativeResponse,false);assert.equal(after.uniformCompletedBeforeNativeResponse,true);
 assert.deepEqual(before.nativeInputHashes,after.nativeInputHashes);assert.deepEqual(before.complexResultHashes,after.complexResultHashes);
 const folder=path.resolve(args['--out-dir']);fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,'before.ts'),beforeSource);fs.writeFileSync(path.join(folder,'after.ts'),afterSource);
 const report={timestamp:new Date().toISOString(),scope:'Operation ordering with a controlled native-response gate; actual production repair factories; no model/network/browser or elapsed-time speed claim.',beforeCommit,beforeSourceSha256:hash(beforeSource),afterSourceSha256:hash(afterSource),admission:'No deletion is in progress; existing withMangaModelAdmission delegates directly. Actual router reachability is separately exercised by mangaInpainting.test.ts.',before,after,limits:['Same-reader mangaSession remains serial; this addresses concurrent different requests such as two manga tabs.','No change to complex-page model inputs, native-run counts, pixels or global resource budgets.','Uniform calls do not acquire/extend model residency; existing active complex work retains its own idle timer.']};
 fs.writeFileSync(path.join(folder,'queue-order.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
