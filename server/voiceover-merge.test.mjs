import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSrtCaptions} from './media-plan.mjs';
import {buildConcatArgs, formatSrtTime, mergeSrtParts, partOffsetsMs} from './voiceover-merge.mjs';

const srt = (...cues) =>
  cues.map(([start, end, text], index) => `${index + 1}\n${start} --> ${end}\n${text}`).join('\n\n');

test('formatSrtTime handles hours and milliseconds', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(3_723_045), '01:02:03,045');
});

test('partOffsetsMs adds gap after every previous part', () => {
  assert.deepEqual(partOffsetsMs([10, 5.5, 3], 0.3), [0, 10_300, 16_100]);
});

test('mergeSrtParts shifts cues by part duration plus gap and renumbers', () => {
  const merged = mergeSrtParts(
    [
      {srtText: srt(['00:00:00,000', '00:00:04,000', 'Một'], ['00:00:04,000', '00:00:09,800', 'Hai']), durationSec: 10},
      {srtText: srt(['00:00:00,100', '00:00:05,000', 'Ba']), durationSec: 5.5},
      {srtText: '﻿' + srt(['00:00:00,000', '00:00:02,500', 'Bốn']), durationSec: 3},
    ],
    0.3,
  );
  const captions = parseSrtCaptions(merged);
  assert.deepEqual(
    captions.map(({text, startMs, endMs}) => [text, startMs, endMs]),
    [
      ['Một', 0, 4000],
      ['Hai', 4000, 9800],
      ['Ba', 10_400, 15_300],
      ['Bốn', 16_100, 18_600],
    ],
  );
  assert.match(merged, /^1\n00:00:00,000 --> 00:00:04,000\nMột\n\n2\n/);
  assert.match(merged, /\n4\n00:00:16,100 --> 00:00:18,600\nBốn\n$/);
});

test('buildConcatArgs fixes every part to duration plus gap, last part without gap', () => {
  const parts = [
    {path: 'a.mp3', durationSec: 10},
    {path: 'b.mp3', durationSec: 5.5},
    {path: 'c.mp3', durationSec: 3},
  ];
  const args = buildConcatArgs(parts, 0.3, 'out.mp3');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:a\][^;]*atrim=end=10\.000,apad=whole_dur=10\.300\[a0\]/);
  assert.match(filter, /\[1:a\][^;]*atrim=end=5\.500,apad=whole_dur=5\.800\[a1\]/);
  assert.match(filter, /\[2:a\][^;]*atrim=end=3\.000,apad=whole_dur=3\.000\[a2\]/);
  assert.match(filter, /\[a0\]\[a1\]\[a2\]concat=n=3:v=0:a=1\[out\]$/);
  assert.deepEqual(args.filter((_value, index) => args[index - 1] === '-i'), ['a.mp3', 'b.mp3', 'c.mp3']);
  assert.equal(args.at(-1), 'out.mp3');
});
