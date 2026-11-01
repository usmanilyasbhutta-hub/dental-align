// Load the real cv-worker.js in Node with shims; feed a keystoned frame (right side farther/smaller).
const fs=require('fs'), vm=require('vm');
const cvPath=require.resolve('@techstark/opencv-js');
const msgs=[]; let onmsg;
const self={ postMessage:(m)=>msgs.push(m) };
const ctx={ self, console, performance, setTimeout, Math, Float32Array, Int8Array, Uint8Array, Array, Map, Set, Promise, JSON, String, Number,
  postMessage:(m)=>msgs.push(m), importScripts:()=>{ const cv=require(cvPath); ctx.cv=cv; cv.onRuntimeInitialized=()=>{ ctx.self.Module.onRuntimeInitialized(); }; } };
ctx.globalThis=ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(''+require('path').join(__dirname,'../public/cv-worker.js')+'','utf8'), ctx);
function pgm(p){const b=fs.readFileSync(p);let s=b.toString('latin1',0,50).split(/\s+/);const w=+s[1],h=+s[2];return {w,h,d:b.subarray(b.length-w*h)}}
const params={clahe:true,refDetect:2500,refTarget:120,refGrid:8,liveDetect:1200,ratio:0.8,maxHamming:80,ransacPx:4,minCandidates:12,minInliers:10,trackMaxAgeMs:400,trackRadius:20,trackMaxHamming:64,trackRatio:0.9};
const wait=()=>new Promise(r=>{const i=setInterval(()=>{if(msgs.find(m=>m.type==='ready')){clearInterval(i);r()}},20)});
(async()=>{
  await wait(); const cv=ctx.cv;
  const g=pgm('g1.pgm'); const src=new cv.Mat(g.h,g.w,cv.CV_8UC1); src.data.set(g.d);
  const W=360,H=640; const ref=new cv.Mat(); cv.resize(src,ref,new cv.Size(W,H),0,0,cv.INTER_AREA);
  const send=(type,m,extra={})=>{ctx.self.onmessage({data:{type,w:W,h:H,gray:new Uint8Array(m.data).buffer,crop:new Uint8Array(m.data).buffer,cropW:W,cropH:H,params,id:1,...extra}}); return msgs[msgs.length-1];};
  const r0=send('setReference',ref); console.log('ref kept',r0.points.length,'detected',r0.detected);
  const test=(name,dst)=>{ // dst corners for src corners TL,TR,BR,BL
    const S=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,W,0,W,H,0,H]); const D=cv.matFromArray(4,1,cv.CV_32FC2,dst);
    const M=cv.getPerspectiveTransform(S,D); const out=new cv.Mat(); cv.warpPerspective(ref,out,M,new cv.Size(W,H));
    const r=send('frame',out);
    console.log(name.padEnd(28),r.matchMode,'inl',r.inliers,'tx',r.tx?.toFixed(3),'s',r.scale?.toFixed(3),'px',r.px?.toFixed(3),'py',r.py?.toFixed(3),'persp',r.perspResidual?.toFixed(3));
  };
  const k=30;
  test('right side smaller (farther)',[0,0,W,k,W,H-k,0,H]);
  test('left side smaller (farther)',[0,k,W,0,W,H,0,H-k]);
  test('bottom smaller (farther)',[0,0,W,0,W-k,H,k,H]);
  test('top smaller (farther)',[k,0,W-k,0,W,H,0,H]);
  test('identity',[0,0,W,0,W,H,0,H]);
})();
