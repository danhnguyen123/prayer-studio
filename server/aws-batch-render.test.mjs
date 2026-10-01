import test from 'node:test';
import assert from 'node:assert/strict';
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
});
