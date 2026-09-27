import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PROJECT_ROOT} from './constants.mjs';

test('Lambda render uses resilient media timeouts and conservative concurrency', async () => {
  const lambdaSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server/lambda-render.mjs'),
    'utf8',
  );
  const compositionSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'remotion/PrayerVideo.tsx'),
    'utf8',
  );

  assert.match(lambdaSource, /REMOTION_CONCURRENCY \|\| 150/);
  assert.match(lambdaSource, /timeoutInMilliseconds: 120_000/);
  assert.match(lambdaSource, /REMOTION_LOG_LEVEL === 'verbose'/);
  assert.match(compositionSource, /MEDIA_DELAY_RENDER_TIMEOUT_MS = 120_000/);
  assert.match(compositionSource, /MEDIA_DELAY_RENDER_RETRIES = 2/);
  assert.equal(
    (compositionSource.match(/delayRenderTimeoutInMilliseconds=/g) || []).length,
    4,
  );
  assert.equal(
    (compositionSource.match(/delayRenderRetries=/g) || []).length,
    4,
  );
});
