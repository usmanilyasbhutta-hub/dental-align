Verification scripts used before delivery (run from this folder after `npm install` in the project root, plus `pip install numpy pillow` and ffmpeg):

- `make_video.py` — builds a synthetic intraoral-like video with a scripted camera error (writes fake.mjpeg; convert with
  `ffmpeg -i fake.mjpeg -vf scale=540:960 -r 15 -pix_fmt yuv420p fake.y4m`).
- `e2e.js` — Playwright: runs the built app (`npx vite preview --port 4173`) against the fake camera, captures baseline + follow-up, dumps logs. Edit the y4m path inside.
- `persp.js` — loads the real `public/cv-worker.js` in Node, checks perspective sign in four directions (needs g1.pgm from the video).
- `anatomy.js` — changed-anatomy robustness test (needs g1.pgm / g2.pgm: frames 15 and 100 of the video as grayscale PGM).
