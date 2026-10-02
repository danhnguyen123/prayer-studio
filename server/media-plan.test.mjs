import test from 'node:test';
import assert from 'node:assert/strict';
import {createRandom, parseSrtCaptions} from './media-plan.mjs';

test('seeded random generator is deterministic', () => {
  const first = createRandom('prayer');
  const second = createRandom('prayer');
  assert.deepEqual(
    [first(), first(), first()],
    [second(), second(), second()],
  );
});

test('internal SRT parser supports multiline captions and comma timestamps', () => {
  const captions = parseSrtCaptions(`1\n00:00:01,250 --> 00:00:03,500\nLine one\nLine two\n\n2\n00:00:04.000 --> 00:00:05.125\nNext`);
  assert.deepEqual(captions, [
    {text: 'Line one\nLine two', startMs: 1250, endMs: 3500, timestampMs: null, confidence: null},
    {text: 'Next', startMs: 4000, endMs: 5125, timestampMs: null, confidence: null},
  ]);
});
