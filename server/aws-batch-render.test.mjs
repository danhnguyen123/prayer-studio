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
  assert.match(ass, /Style: Caption,Noto Sans,124,/);
});

test('FFmpeg image zoom uses a 2x canvas with stable even coordinates and no lower overlay', async () => {
  const worker = await fs.readFile(new URL('../worker/ffmpeg-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /zoomSourceWidth = plan\.width \* 2/);
  assert.match(worker, /trunc\(\(iw-iw\/zoom\)\/4\)\*2/);
  assert.doesNotMatch(worker, /drawbox=x=0:y=ih\*0\.48/);
});
