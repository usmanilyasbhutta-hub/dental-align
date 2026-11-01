# Synthetic intraoral-like scene + scripted camera misalignment, written as MJPEG for Chromium's fake camera.
import numpy as np, math, subprocess
from PIL import Image, ImageDraw, ImageFilter
rng=np.random.default_rng(3)
W,H=720,1280  # portrait frames (like an iPhone held upright)
S=1600
scene=Image.new('RGB',(S,S),(120,40,45))   # gingiva/lip background
d=ImageDraw.Draw(scene)
# gum texture
arr=np.array(scene).astype(np.float32)
arr+=rng.normal(0,10,arr.shape)
scene=Image.fromarray(np.clip(arr,0,255).astype(np.uint8)); d=ImageDraw.Draw(scene)
# two arches of "teeth"
for row,(cy,sgn) in enumerate([(700,-1),(900,1)]):
    for i in range(-5,6):
        cx=800+i*95; w=82-abs(i)*3; h=170-abs(i)*8
        y=cy+sgn*abs(i)**1.6*6
        top=y-h if sgn<0 else y; bot=y if sgn<0 else y+h
        shade=int(225-abs(i)*6)
        d.rounded_rectangle([cx-w/2,top,cx+w/2,bot],radius=26,fill=(shade,shade-8,shade-28),outline=(150,120,110),width=3)
        # enamel texture details: perikymata lines, small stains, a restoration
        for k in range(6):
            yy=top+(k+1)*(bot-top)/7
            d.line([cx-w/2+8,yy+rng.normal(0,3),cx+w/2-8,yy+rng.normal(0,3)],fill=(shade-25,shade-35,shade-55),width=2)
        for k in range(4):
            px=cx+rng.uniform(-w/3,w/3); py=rng.uniform(top+10,bot-10); r=rng.uniform(2,6)
            d.ellipse([px-r,py-r,px+r,py+r],fill=(int(shade*0.7),int(shade*0.6),int(shade*0.45)))
        if i==2 and row==1:
            d.rounded_rectangle([cx-20,top+40,cx+22,top+95],radius=8,fill=(170,170,175))
scene=scene.filter(ImageFilter.GaussianBlur(1.2))
arr=np.array(scene).astype(np.float32)+rng.normal(0,4,(S,S,3))
scene=Image.fromarray(np.clip(arr,0,255).astype(np.uint8))
scene.save('scene.png')

fps=30; dur=12
def pose(t):
    # aligned 0-3s, drift to offset 3-5s, hold 5-8s, return 8-10.5s, aligned to 12
    def ease(x): x=min(1,max(0,x)); return x*x*(3-2*x)
    if t<3: a=0
    elif t<5: a=ease((t-3)/2)
    elif t<8: a=1
    elif t<10.5: a=1-ease((t-8)/2.5)
    else: a=0
    # content appears shifted RIGHT by 8% width, DOWN 3%, 7% larger, rotated 4° clockwise
    return dict(tx=0.08*a, ty=0.03*a, s=1+0.07*a, rot=4*a)
p=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(fps),'-i','-','-q:v','3','-f','mjpeg','fake.mjpeg'],stdin=subprocess.PIPE)
base_scale=W/900  # view 900px wide region of scene
for f in range(fps*dur):
    t=f/fps; q=pose(t)
    # affine: output pixel -> scene pixel (inverse map). content transform: out = C + s*R*(scene-sc)*base + t
    s=q['s']*base_scale; th=math.radians(q['rot'])
    ox=W/2+q['tx']*W; oy=H/2+q['ty']*W
    ca,sa=math.cos(th),math.sin(th)
    # out = [ca -sa; sa ca]*s*(p - c) + o   (clockwise on screen for +th in y-down)
    # inverse: p = c + (1/s) R^T (out - o)
    a=ca/s; b=sa/s
    c0=800- (a*ox + b*oy); c1=800 - (-b*ox + a*oy)
    # PIL affine expects (a,b,c,d,e,f): x_in = a*x+b*y+c, y_in = d*x+e*y+f
    img=scene.transform((W,H),Image.AFFINE,(a,b,c0,-b,a,c1),resample=Image.BILINEAR)
    p.stdin.write(img.tobytes())
p.stdin.close(); p.wait()
print('done')
