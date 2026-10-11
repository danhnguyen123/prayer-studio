import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {LANGUAGE_DEFINITIONS, PROJECT_ROOT} from './constants.mjs';
import {validateSpeed, validateVoiceId} from './ai33.mjs';

export const DEFAULT_GAP_SECONDS = 0.3;
export const DEFAULT_MAX_CHARS = 950;

const clampGap = (value) => {
  const gap = Number(value);
  if (!Number.isFinite(gap) || gap < 0 || gap > 5) {
    throw new Error('Khoảng nghỉ giữa các phần phải nằm trong 0 – 5 giây.');
  }
  return Math.round(gap * 1000) / 1000;
};

const clampMaxChars = (value) => {
  const maxChars = Math.round(Number(value));
  if (!Number.isFinite(maxChars) || maxChars < 200 || maxChars > 5000) {
    throw new Error('Số ký tự mỗi phần phải nằm trong 200 – 5000.');
  }
  return maxChars;
};

const emptyLanguage = () => ({defaultVoiceKey: null, voices: []});

const normalizeSettings = (raw) => {
  const settings = {
    gapSeconds: DEFAULT_GAP_SECONDS,
    maxChars: DEFAULT_MAX_CHARS,
    languages: {},
  };
  if (Number.isFinite(Number(raw?.gapSeconds))) settings.gapSeconds = Number(raw.gapSeconds);
  if (Number.isFinite(Number(raw?.maxChars))) settings.maxChars = Number(raw.maxChars);
  for (const code of Object.keys(LANGUAGE_DEFINITIONS)) {
    const saved = raw?.languages?.[code];
    const voices = Array.isArray(saved?.voices) ? saved.voices.filter((voice) => voice?.key) : [];
    const defaultVoiceKey = voices.some((voice) => voice.key === saved?.defaultVoiceKey)
      ? saved.defaultVoiceKey
      : voices[0]?.key || null;
    settings.languages[code] = {...emptyLanguage(), voices, defaultVoiceKey};
  }
  return settings;
};

const validateName = (value, fallback) => {
  const name = String(value ?? '').trim().slice(0, 80);
  return name || fallback;
};

export const createVoiceSettingsStore = ({settingsPath, sampleRoot}) => {
  let settings;
  try {
    settings = normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[voice settings] Không đọc được ${settingsPath}: ${error.message}`);
    settings = normalizeSettings(null);
  }

  const persist = () => {
    mkdirSync(path.dirname(settingsPath), {recursive: true});
    const temporary = `${settingsPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(settings, null, 2));
    renameSync(temporary, settingsPath);
  };

  const getLanguage = (code) => {
    if (!LANGUAGE_DEFINITIONS[code]) throw new Error(`Ngôn ngữ không hỗ trợ: ${code}`);
    return settings.languages[code];
  };

  const findVoice = (code, key) => {
    const voice = getLanguage(code).voices.find((item) => item.key === key);
    if (!voice) throw new Error('Không tìm thấy voice.');
    return voice;
  };

  const samplePathFor = (voice) => (voice.sample?.fileName ? path.join(sampleRoot, voice.sample.fileName) : null);

  return {
    sampleRoot,
    getSettings: () => structuredClone(settings),

    updateGlobalSettings: ({gapSeconds, maxChars} = {}) => {
      if (gapSeconds !== undefined) settings.gapSeconds = clampGap(gapSeconds);
      if (maxChars !== undefined) settings.maxChars = clampMaxChars(maxChars);
      persist();
      return structuredClone(settings);
    },

    // `name`, `language`, `gender` lấy từ ai33 (lookupVoice) trước khi gọi.
    addVoice: (code, {name, voiceId, speed = 1, language: voiceLanguage = null, gender = null} = {}) => {
      const language = getLanguage(code);
      const validVoiceId = validateVoiceId(voiceId);
      if (language.voices.some((item) => item.voiceId === validVoiceId)) {
        throw new Error('Voice ID này đã có trong ngôn ngữ.');
      }
      const voice = {
        key: randomUUID(),
        name: validateName(name, validVoiceId),
        voiceId: validVoiceId,
        speed: validateSpeed(speed),
        language: voiceLanguage,
        gender,
        sample: null,
        createdAt: new Date().toISOString(),
      };
      language.voices.push(voice);
      if (!language.defaultVoiceKey) language.defaultVoiceKey = voice.key;
      persist();
      return structuredClone(voice);
    },

    updateVoice: (code, key, patch = {}) => {
      const voice = findVoice(code, key);
      if (patch.voiceId !== undefined) {
        const voiceId = validateVoiceId(patch.voiceId);
        if (getLanguage(code).voices.some((item) => item.key !== key && item.voiceId === voiceId)) {
          throw new Error('Voice ID này đã có trong ngôn ngữ.');
        }
        voice.voiceId = voiceId;
      }
      if (patch.name !== undefined) voice.name = validateName(patch.name, voice.name);
      if (patch.language !== undefined) voice.language = patch.language;
      if (patch.gender !== undefined) voice.gender = patch.gender;
      if (patch.speed !== undefined) voice.speed = validateSpeed(patch.speed);
      persist();
      return structuredClone(voice);
    },

    deleteVoice: (code, key) => {
      const language = getLanguage(code);
      const voice = findVoice(code, key);
      const samplePath = samplePathFor(voice);
      if (samplePath) rmSync(samplePath, {force: true});
      language.voices = language.voices.filter((item) => item.key !== key);
      if (language.defaultVoiceKey === key) language.defaultVoiceKey = language.voices[0]?.key || null;
      persist();
    },

    setDefaultVoice: (code, key) => {
      findVoice(code, key);
      getLanguage(code).defaultVoiceKey = key;
      persist();
    },

    resolveVoice: (code, key) => {
      const language = getLanguage(code);
      const voiceKey = key || language.defaultVoiceKey;
      if (!voiceKey) throw new Error(`${LANGUAGE_DEFINITIONS[code].label}: chưa có voice nào. Thêm ở trang Voice.`);
      return structuredClone(findVoice(code, voiceKey));
    },

    newSamplePath: (code, key) => {
      findVoice(code, key);
      mkdirSync(sampleRoot, {recursive: true});
      return path.join(sampleRoot, `${code}-${key}.mp3`);
    },

    setVoiceSample: (code, key, {text, filePath, voiceId, speed}) => {
      const voice = findVoice(code, key);
      voice.sample = {
        text: String(text),
        voiceId,
        speed,
        fileName: path.basename(filePath),
        createdAt: new Date().toISOString(),
      };
      persist();
      return structuredClone(voice);
    },

    samplePath: (code, key) => samplePathFor(findVoice(code, key)),
  };
};

export const voiceSettings = createVoiceSettingsStore({
  settingsPath: path.resolve(
    process.env.VOICE_SETTINGS_PATH?.trim() || path.join(PROJECT_ROOT, 'workspace', 'state', 'voice-settings.json'),
  ),
  sampleRoot: path.resolve(process.env.VOICE_SAMPLE_ROOT?.trim() || path.join(PROJECT_ROOT, 'workspace', 'voice-samples')),
});
