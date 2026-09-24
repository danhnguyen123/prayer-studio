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
  }
});
