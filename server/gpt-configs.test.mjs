import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {LANGUAGE_DEFINITIONS, PROJECT_ROOT} from './constants.mjs';

test('GPT Terra configs use one part and reuse DeepSeek personas', async () => {
  for (const definition of Object.values(LANGUAGE_DEFINITIONS)) {
    const deepseek = parse(
      await fs.readFile(path.join(PROJECT_ROOT, definition.configs.deepseek), 'utf8'),
    );
    const gpt = parse(
      await fs.readFile(path.join(PROJECT_ROOT, definition.configs.gpt), 'utf8'),
    );
    assert.equal(gpt.provider, 'openai');
    assert.equal(gpt.api_file, 'API_OPENAI.txt');
    assert.equal(gpt.processing_mode, 'standard');
    assert.equal(gpt.model_generation, 'gpt-5.6-terra');
    assert.equal(gpt.reasoning_effort, 'medium');
    assert.equal(gpt.length_per_part, gpt.target_length);
    assert.equal(gpt.persona_file, deepseek.persona_file);
    assert.equal(gpt.output_language, definition.targetName);
    assert.equal(deepseek.output_language, definition.targetName);
  }
});

test('GPT Terra prayer targets use the calibrated word budgets', async () => {
  const expected = {
    italia: {target: 4500, unit: 'auto'},
    poland: {target: 5900, unit: 'auto'},
    korea: {target: 2800, unit: 'words'},
  };
  for (const [code, calibration] of Object.entries(expected)) {
    const definition = LANGUAGE_DEFINITIONS[code];
    const gpt = parse(
      await fs.readFile(path.join(PROJECT_ROOT, definition.configs.gpt), 'utf8'),
    );
    assert.equal(gpt.target_length, calibration.target);
    assert.equal(gpt.length_per_part, calibration.target);
    assert.equal(gpt.length_unit, calibration.unit);
  }
});

test('UI defaults every language to GPT Terra direct from Korean', async () => {
  const app = await fs.readFile(path.join(PROJECT_ROOT, 'web/src/App.tsx'), 'utf8');
  for (const code of Object.keys(LANGUAGE_DEFINITIONS)) {
    assert.match(app, new RegExp(`${code}: 'gpt-korea'`));
  }
  assert.match(app, /value="gpt-korea">Rewrite thẳng từ tiếng Hàn[^<]+Mặc định/);
});
