import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PROJECT_ROOT} from './constants.mjs';

test('AWS Batch stack allows five 4-vCPU ARM Spot workers', async () => {
  const template = await fs.readFile(
    path.join(PROJECT_ROOT, 'infra', 'aws-batch-one-worker.yml'),
    'utf8',
  );
  assert.match(template, /Type: SPOT/);
  assert.match(template, /MaxvCpus: 20/);
  assert.match(template, /InstanceTypes: \[c7g\.xlarge, c6g\.xlarge\]/);
  assert.match(template, /Vcpus: 4/);
  assert.match(template, /Memory: 7500/);
  assert.match(template, /ImageType:\s+ECS_AL2023\b/);
  assert.doesNotMatch(template, /ECS_AL2023_ARM64/);
  assert.match(template, /SPOT_PRICE_CAPACITY_OPTIMIZED/);
});

test('AWS Batch renderer runs at most five languages concurrently', async () => {
  const source = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'aws-batch-render.mjs'),
    'utf8',
  );
  assert.match(source, /maxParallelWorkers = 5/);
  assert.match(source, /mapWithConcurrency\(languages, maxParallelWorkers/);
  assert.doesNotMatch(source, /for \(const code of languages\)/);
});
