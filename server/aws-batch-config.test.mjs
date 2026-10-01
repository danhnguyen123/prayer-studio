import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PROJECT_ROOT} from './constants.mjs';

test('AWS Batch stack enforces one 8-vCPU ARM Spot worker', async () => {
  const template = await fs.readFile(
    path.join(PROJECT_ROOT, 'infra', 'aws-batch-one-worker.yml'),
    'utf8',
  );
  assert.match(template, /Type: SPOT/);
  assert.match(template, /MaxvCpus: 8/);
  assert.match(template, /Vcpus: 8/);
  assert.match(template, /ECS_AL2023_ARM64/);
  assert.match(template, /SPOT_PRICE_CAPACITY_OPTIMIZED/);
});

test('AWS Batch renderer queues languages sequentially', async () => {
  const source = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'aws-batch-render.mjs'),
    'utf8',
  );
  assert.match(source, /for \(const code of languages\)/);
  assert.doesNotMatch(source, /Promise\.all\(\s*languages/);
});
