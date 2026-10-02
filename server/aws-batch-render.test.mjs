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
  assert.match(ass, /Style: Verse,Noto Serif,92,/);
  assert.doesNotMatch(ass, /VerseFrame|\\p1/);
  assert.match(ass, /0:00:08\.50,0:00:09\.50,Caption/);
  assert.match(ass, /Outline, Shadow/);
  assert.match(ass, /Style: Caption,Noto Sans,112,/);
  assert.match(ass, /,1,3\.5,0\.7,5,/);
});

test('FFmpeg images remain static at Full HD and have no lower overlay', async () => {
  const worker = await fs.readFile(new URL('../worker/ffmpeg-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /'-loop', '1', '-framerate', String\(plan\.fps\)/);
  assert.doesNotMatch(worker, /zoompan|zoomSourceWidth|lanczos\+accurate_rnd/);
  assert.doesNotMatch(worker, /drawbox=x=0:y=ih\*0\.48/);
});
