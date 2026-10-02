import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildAss} from '../worker/ffmpeg-worker.mjs';

test('FFmpeg worker shifts voice captions after intro and fades verse', () => {
  const ass = buildAss({
    width: 1920,
    height: 1080,
    introSeconds: 8,
    introText: 'Verse line 1\nVerse line 2',
    captions: [{startMs: 500, endMs: 1500, text: 'Prayer caption'}],
  });
  assert.match(ass, /\\fad\(3000,1000\)/);
  assert.match(ass, /Verse line 1\\NVerse line 2/);
  assert.match(ass, /0:00:08\.50,0:00:09\.50,Caption/);
  assert.match(ass, /Outline, Shadow/);
  assert.match(ass, /Style: Caption,Noto Sans,112,/);
  assert.match(ass, /,1,3\.5,0\.7,5,/);
});

test('FFmpeg image zoom renders on a 2x canvas before stable downscaling and has no lower overlay', async () => {
  const worker = await fs.readFile(new URL('../worker/ffmpeg-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /zoomSourceWidth = plan\.width \* 2/);
  assert.match(worker, /trunc\(\(iw-iw\/zoom\)\/4\)\*2/);
  assert.match(worker, /s=\$\{zoomSourceWidth\}x\$\{zoomSourceHeight\}:fps=/);
  assert.match(worker, /flags=lanczos\+accurate_rnd/);
  assert.doesNotMatch(worker, /drawbox=x=0:y=ih\*0\.48/);
});
