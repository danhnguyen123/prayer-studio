import test from 'node:test';
import assert from 'node:assert/strict';
import {createRandom} from './media-plan.mjs';

test('seeded random generator is deterministic', () => {
  const first = createRandom('prayer');
  const second = createRandom('prayer');
  assert.deepEqual(
    [first(), first(), first()],
    [second(), second(), second()],
  );
});
