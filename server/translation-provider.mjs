import {translatePrayerScript as translateWithKie} from './kie.mjs';
import {
  translatePrayerScriptOpenAI,
  translatePrayerScriptsOpenAIBatch,
} from './openai.mjs';

export const translatePrayerScript = async (
  koreanScript,
  languageCode,
  {provider = 'openai'} = {},
) => {
  if (provider === 'openai') return translatePrayerScriptOpenAI(koreanScript, languageCode);
  if (provider === 'kie') return translateWithKie(koreanScript, languageCode);
  throw new Error(`Provider dịch không hỗ trợ: ${provider}`);
};

export const translatePrayerScriptsBatch = async (
  koreanScript,
  languageCodes,
  {provider = 'openai', ...options} = {},
) => {
  if (provider !== 'openai') {
    throw new Error('Batch processing hiện chỉ hỗ trợ OpenAI API chính thức.');
  }
  return translatePrayerScriptsOpenAIBatch(koreanScript, languageCodes, options);
};

