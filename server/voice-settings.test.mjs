import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createVoiceSettingsStore} from './voice-settings.mjs';

const withStore = (run) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-settings-'));
  try {
    const options = {
      settingsPath: path.join(directory, 'state', 'voice-settings.json'),
      sampleRoot: path.join(directory, 'samples'),
    };
    run(createVoiceSettingsStore(options), options);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
};

test('defaults to 0.3s gap and empty voice lists', () => {
  withStore((store) => {
    const settings = store.getSettings();
    assert.equal(settings.gapSeconds, 0.3);
    assert.equal(settings.maxChars, 950);
    assert.deepEqual(settings.languages.france, {defaultVoiceKey: null, voices: []});
  });
});

test('first voice becomes default and settings persist to disk', () => {
  withStore((store, options) => {
    const first = store.addVoice('france', {name: 'Henri', voiceId: 'edge_fr-FR-HenriNeural', speed: 0.9});
    store.addVoice('france', {voiceId: 'elevenlabs_abc', speed: 1});
    const reloaded = createVoiceSettingsStore(options).getSettings();
    assert.equal(reloaded.languages.france.defaultVoiceKey, first.key);
    assert.equal(reloaded.languages.france.voices.length, 2);
    assert.equal(reloaded.languages.france.voices[1].name, 'elevenlabs_abc');
  });
});

test('rejects duplicate voice ids and rounds speed to 0.01', () => {
  withStore((store) => {
    const first = store.addVoice('italia', {voiceId: 'edge_it-IT-A', speed: 0.973});
    assert.equal(first.speed, 0.97);
    assert.throws(() => store.addVoice('italia', {voiceId: 'edge_it-IT-A'}), /đã có/);
    const second = store.addVoice('italia', {voiceId: 'edge_it-IT-B'});
    assert.throws(() => store.updateVoice('italia', second.key, {voiceId: 'edge_it-IT-A'}), /đã có/);
    assert.equal(store.updateVoice('italia', second.key, {speed: 1.01}).speed, 1.01);
  });
});

test('validates voice id prefix, speed, gap and language', () => {
  withStore((store) => {
    assert.throws(() => store.addVoice('france', {voiceId: 'abc'}), /prefix/);
    assert.throws(() => store.addVoice('france', {voiceId: 'edge_x', speed: 2}), /Speed/);
    assert.throws(() => store.addVoice('spain', {voiceId: 'edge_x'}), /không hỗ trợ/);
    assert.throws(() => store.updateGlobalSettings({gapSeconds: 6}), /0 – 5/);
    assert.equal(store.updateGlobalSettings({gapSeconds: 1.25}).gapSeconds, 1.25);
  });
});

test('deleting the default voice moves default and removes its sample', () => {
  withStore((store) => {
    const first = store.addVoice('poland', {voiceId: 'edge_pl-PL-A'});
    const second = store.addVoice('poland', {voiceId: 'edge_pl-PL-B'});
    const samplePath = store.newSamplePath('poland', first.key);
    writeFileSync(samplePath, 'mp3');
    store.setVoiceSample('poland', first.key, {text: 'Test', filePath: samplePath, voiceId: first.voiceId, speed: 1});
    assert.equal(store.samplePath('poland', first.key), samplePath);

    store.deleteVoice('poland', first.key);
    assert.equal(existsSync(samplePath), false);
    assert.equal(store.getSettings().languages.poland.defaultVoiceKey, second.key);
    assert.equal(store.resolveVoice('poland').key, second.key);
  });
});

test('resolveVoice explains missing voices', () => {
  withStore((store) => {
    assert.throws(() => store.resolveVoice('germany'), /chưa có voice/);
  });
});

test('ignores unreadable settings file', () => {
  withStore((store, options) => {
    store.updateGlobalSettings({gapSeconds: 2});
    writeFileSync(options.settingsPath, '{broken');
    assert.equal(createVoiceSettingsStore(options).getSettings().gapSeconds, 0.3);
  });
});
