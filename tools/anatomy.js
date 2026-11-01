const fs=require('fs'), vm=require('vm');
const msgs=[]; const self={postMessage:(m)=>msgs.push(m)};
const ctx={self,console,performance,setTimeout,Math,Float32Array,Int8Array,Uint8Array,Array,Map,Set,Promise,JSON,String,Number,postMessage:(m)=>msgs.push(m),
 importScripts:()=>{const cv=require('@techstark/opencv-js');ctx.cv=cv;cv.onRuntimeInitialized=()=>ctx.self.Module.onRuntimeInitialized();}};
vm.createContext(ctx); vm.runInContext(fs.readFileSync(''+require('path').join(__dirname,'../public/cv-worker.js')+'','utf8'),ctx);
function pgm(p){const b=fs.readFileSync(p);let s=b.toString('latin1',0,50).split(/\s+/);const w=+s[1],h=+s[2];return {w,h,d:b.subarray(b.length-w*h)}}
const params={clahe:true,refDetect:2500,refTarget:120,refGrid:8,liveDetect:1200,ratio:0.8,maxHamming:80,ransacPx:4,minCandidates:12,minInliers:10,trackMaxAgeMs:0,trackRadius:20,trackMaxHamming:64,trackRatio:0.9};
(async()=>{
  await new Promise(r=>{const i=setInterval(()=>{if(msgs.find(m=>m.type==='ready')){clearInterval(i);r()}},20)});
  const cv=ctx.cv; const W=360,H=640;
  const load=(p)=>{const g=pgm(p);const m=new cv.Mat(g.h,g.w,cv.CV_8UC1);m.data.set(g.d);const o=new cv.Mat();cv.resize(m,o,new cv.Size(W,H),0,0,cv.INTER_AREA);return o};
  const ref=load('g1.pgm'), live=load('g2.pgm'); // g2 = offset frame (tx .08, ty .03, s 1.07, 4deg)
  const send=(type,m)=>{ctx.self.onmessage({data:{type,w:W,h:H,gray:new Uint8Array(m.data).buffer,crop:new Uint8Array(m.data).buffer,cropW:W,cropH:H,params,id:1}});return msgs[msgs.length-1]};
  const r0=send('setReference',ref);
  const base=send('frame',live);
  // "treatment": central 3 upper + 2 lower teeth replaced by smooth crowns / preparation
  const changed=live.clone();
  cv.rectangle(changed,new cv.Point(110,250),new cv.Point(270,345),new cv.Scalar(205),-1);
  cv.rectangle(changed,new cv.Point(140,370),new cv.Point(250,460),new cv.Scalar(150),-1);
  cv.circle(changed,new cv.Point(300,420),30,new cv.Scalar(255),-1); // specular highlight / saliva
  const r=send('frame',changed);
  const inChanged=(p)=> (p.x>=110*0.97&&p.x<=270&&p.y>=230&&p.y<=350)||(p.x>=130&&p.x<=255&&p.y>=355&&p.y<=465);
  let a={in:[0,0,0],out:[0,0,0]};
  r0.points.forEach((p,i)=>{const k=inChanged(p)?'in':'out'; a[k][r.status[i]+1]++;});
  console.log('ref points',r0.points.length);
  console.log('unchanged anatomy :', 'inl',base.inliers,'tx',base.tx.toFixed(4),'ty',base.ty.toFixed(4),'s',base.scale.toFixed(4),'roll',(base.roll*180/Math.PI).toFixed(2));
  console.log('changed anatomy   :', 'inl',r.inliers,'cand',r.candidates,'tx',r.tx.toFixed(4),'ty',r.ty.toFixed(4),'s',r.scale.toFixed(4),'roll',(r.roll*180/Math.PI).toFixed(2));
  console.log('ref points inside changed region  [unmatched, outlier, inlier]:',a.in);
  console.log('ref points outside changed region [unmatched, outlier, inlier]:',a.out);
  const PNG=require('fs'); cv.imwrite; // n/a
  const o=new cv.Mat(); cv.cvtColor(changed,o,cv.COLOR_GRAY2RGBA); fs.writeFileSync('changed.raw',Buffer.from(o.data));
})();
