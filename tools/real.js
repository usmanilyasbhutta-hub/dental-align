const fs=require('fs'), vm=require('vm');
const msgs=[]; const self={postMessage:(m)=>msgs.push(m)};
const ctx={self,console,performance,setTimeout,Math,Float32Array,Int8Array,Uint8Array,Array,Map,Set,Promise,JSON,String,Number,postMessage:(m)=>msgs.push(m),
 importScripts:()=>{const cv=require('@techstark/opencv-js');ctx.cv=cv;cv.onRuntimeInitialized=()=>ctx.self.Module.onRuntimeInitialized();}};
vm.createContext(ctx); vm.runInContext(fs.readFileSync('/home/claude/dental-align/public/cv-worker.js','utf8'),ctx);
const P={clahe:true,refDetect:3000,refTarget:220,refGrid:8,toothShare:0.7,liveDetect:1200,ratio:0.8,maxHamming:80,ransacPx:4,minCandidates:12,minInliers:10,trackMaxAgeMs:0,trackRadius:20,trackMaxHamming:64,trackRatio:0.9};
function load(n,w,h){const d=fs.readFileSync(n+'.rgb');const g=new Uint8Array(w*h),m=new Uint8Array(w*h);for(let i=0,j=0;j<w*h;i+=3,j++){const r=d[i],G=d[i+1],b=d[i+2];const l=(r*77+G*150+b*29)>>8;g[j]=l;if(r-G>=0&&r-G<=48&&b<=G+6&&r-b>=12&&l>105&&l<246)m[j]=255;}return {g,m}}
(async()=>{
  await new Promise(r=>{const i=setInterval(()=>{if(msgs.find(m=>m.type==='ready')){clearInterval(i);r()}},20)});
  const run=(a,b,w,h,mask)=>{const A=load(a,w,h),B=load(b,w,h);
    ctx.self.onmessage({data:{type:'setReference',w,h,gray:A.g.buffer,mask:mask?A.m.buffer:undefined,params:{...P,refTarget:mask?220:120}}});const r0=msgs[msgs.length-1];
    ctx.self.onmessage({data:{type:'frame',id:1,w,h,gray:B.g.buffer.slice(0),crop:B.g.buffer.slice(0),cropW:w,cropH:h,params:P}});const r=msgs[msgs.length-1];
    console.log(`${a}->${b} ${mask?'NEW':'old'}: ref ${r0.points.length} (teeth ${r0.toothPoints}) cand ${r.candidates} inliers ${r.inliers??0} ok ${r.ok} ${r.ok?`t(${r.tx.toFixed(3)},${r.ty.toFixed(3)}) s ${r.scale.toFixed(3)} roll ${(r.roll*180/Math.PI).toFixed(1)}`:''}`)};
  for (const m of [false,true]) { run('ra','rb',640,480,m); run('rc','rd',360,640,m); run('re','rd',360,640,m); }
})();
