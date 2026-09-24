import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  LANGUAGE_DEFINITIONS,
  PROJECT_ROOT,
} from './constants.mjs';
import {appendJobLog, mutateJob, updateJob} from './job-store.mjs';
import {translatePrayerScript, translatePrayerScriptsBatch} from './translation-provider.mjs';

const timestampForFile = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

export const persistTranslation = async (code, content, timestamp = timestampForFile()) => {
    const definition = LANGUAGE_DEFINITIONS[code];
    if (!definition) throw new Error(`Ngôn ngữ không hỗ trợ: ${code}`);
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`Bản dịch ${definition.label} trống.`);
    }
    const relativeSamplePath = path
      .join('samples', 'translate', definition.folder, `${timestamp}.txt`)
      .replaceAll('\\', '/');
    const absoluteSamplePath = path.join(PROJECT_ROOT, relativeSamplePath);
    await fs.mkdir(path.dirname(absoluteSamplePath), {recursive: true});
    await fs.writeFile(absoluteSamplePath, content.trim() + '\n', 'utf8');

    const configFiles = [...new Set(Object.values(definition.configs || {deepseek: definition.config}))];
    for (const relativeConfigPath of configFiles) {
      const configPath = path.join(PROJECT_ROOT, relativeConfigPath);
      const yaml = await fs.readFile(configPath, 'utf8');
      const nextYaml = yaml.replace(
        /^viral_sample_file:\s*.*$/m,
        `viral_sample_file: "${relativeSamplePath}"`,
      );
      if (nextYaml === yaml) {
        throw new Error(`Không tìm thấy key viral_sample_file trong ${relativeConfigPath}`);
      }
      await fs.writeFile(configPath, nextYaml, 'utf8');
    }

    return {
      label: definition.label,
      samplePath: relativeSamplePath,
      absoluteSamplePath,
      configPaths: configFiles,
    };
};

export const persistTranslations = async (translations, selectedLanguages) => {
  const timestamp = timestampForFile();
  const saved = {};
  for (const code of selectedLanguages) {
    const definition = LANGUAGE_DEFINITIONS[code];
    saved[code] = await persistTranslation(
      code,
      translations[definition.translationKey],
      timestamp,
    );
  }
  return saved;
};

const newestTextFile = async (directory) => {
  const entries = await fs.readdir(directory, {withFileTypes: true}).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
      .map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        const stat = await fs.stat(absolutePath);
        return {absolutePath, mtimeMs: stat.mtimeMs};
      }),
  );
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.absolutePath ?? null;
};

export const runOneLanguage = (
  jobId,
  code,
  rewriteMode = 'deepseek',
  processingMode = 'standard',
  translationProvider = 'openai',
) =>
  new Promise((resolve, reject) => {
    const definition = LANGUAGE_DEFINITIONS[code];
    const isGptRewrite = rewriteMode === 'gpt' || rewriteMode === 'gpt-korea';
    const configKey = rewriteMode === 'gpt-korea' ? 'gpt' : rewriteMode;
    const configFile = definition.configs?.[configKey] || definition.config;
    const engineLabel = isGptRewrite
      ? `GPT-5.6 Terra${processingMode === 'batch' ? ' Batch' : ''}${rewriteMode === 'gpt-korea' ? ' (từ tiếng Hàn)' : ''}`
      : 'DeepSeek v4 Pro';
    const executable = process.env.PYTHON_EXECUTABLE || 'python';
    appendJobLog(jobId, `[${definition.label}] Bắt đầu ${engineLabel}...`);

    const argumentsList = ['run.py', 'generate', '--config', configFile];
    if (isGptRewrite) {
      argumentsList.push('--processing-mode', processingMode, '--provider', translationProvider);
    }
    const child = spawn(
      executable,
      argumentsList,
      {cwd: PROJECT_ROOT, windowsHide: true, env: process.env},
    );

    child.stdout.on('data', (chunk) => appendJobLog(jobId, chunk.toString()));
    child.stderr.on('data', (chunk) => appendJobLog(jobId, chunk.toString()));
    child.on('error', (error) => {
      reject(
        new Error(
          `Không chạy được Python (${executable}): ${error.message}. Đặt PYTHON_EXECUTABLE trong .env nếu cần.`,
        ),
      );
    });
    child.on('close', async (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`${definition.label}: Python kết thúc với mã ${exitCode}.`));
        return;
      }
      try {
        const configText = await fs.readFile(
          path.join(PROJECT_ROOT, configFile),
          'utf8',
        );
        const folderMatch = configText.match(/^output_folder:\s*["']?([^"'\r\n]+)["']?/m);
        const outputDir = path.join(
          PROJECT_ROOT,
          folderMatch?.[1]?.trim() || `output/${code}_prayer`,
        );
        const outputPath = await newestTextFile(outputDir);
        if (!outputPath) {
          throw new Error(`${definition.label}: ${engineLabel} không tạo file TXT đầu ra.`);
        }
        const content = await fs.readFile(outputPath, 'utf8');
        resolve({code, outputPath, content});
      } catch (error) {
        reject(error);
      }
    });
  });

export const runGenerationJob = async (jobId, selectedLanguages) => {
  updateJob(jobId, {
    status: 'running',
    progress: 0,
    message: 'Đang tạo kịch bản bằng DeepSeek',
  });
  const results = {};
  try {
    for (let index = 0; index < selectedLanguages.length; index += 1) {
      const code = selectedLanguages[index];
      const result = await runOneLanguage(jobId, code);
      results[code] = result;
      updateJob(jobId, {
        progress: (index + 1) / selectedLanguages.length,
        result: results,
      });
    }
    updateJob(jobId, {
      status: 'completed',
      progress: 1,
      message: 'Đã tạo xong kịch bản',
      result: results,
    });
  } catch (error) {
    appendJobLog(jobId, error.stack || error.message);
    updateJob(jobId, {
      status: 'failed',
      message: error.message,
      error: error.message,
    });
  }
};

const setWorkflowLanguage = (jobId, code, patch) => {
  mutateJob(jobId, (job) => {
    job.languages[code] = {...job.languages[code], ...patch};
    const values = Object.values(job.languages);
    job.progress =
      values.reduce((sum, item) => sum + (item.progress || 0), 0) / values.length;
  });
};

const completeWorkflowLanguage = async (
  jobId,
  code,
  rewriteMode,
  translated,
  processingMode,
  translationProvider,
) => {
  const definition = LANGUAGE_DEFINITIONS[code];
  try {
    const saved = await persistTranslation(code, translated.translation);
    const common = {
      translationModel: translated.model,
      translationProvider: translated.provider,
      processingMode,
      translationPath: saved.samplePath,
      rewriteMode,
    };

    if (rewriteMode === 'translation') {
      const directResult = {
        code,
        outputPath: saved.absoluteSamplePath,
        content: translated.translation,
      };
      setWorkflowLanguage(jobId, code, {
        ...common,
        stage: 'script-ready',
        progress: 1,
        message: 'Đang dùng trực tiếp bản dịch làm kịch bản',
        outputPath: saved.absoluteSamplePath,
        scriptDownloadUrl: `/api/workflows/${jobId}/${code}/script`,
      });
      return directResult;
    }

    const rewriteLabel =
      rewriteMode === 'gpt'
        ? 'GPT-5.6 Terra'
        : rewriteMode === 'gpt-korea'
          ? 'GPT-5.6 Terra (từ tiếng Hàn)'
          : 'DeepSeek v4 Pro';
    setWorkflowLanguage(jobId, code, {
      ...common,
      stage: 'generating',
      progress: 0.45,
      message: `${rewriteLabel} đang rewrite kịch bản`,
      translationPath: saved.samplePath,
    });

    const generated = await runOneLanguage(
      jobId,
      code,
      rewriteMode,
      processingMode,
      translationProvider,
    );
    setWorkflowLanguage(jobId, code, {
      stage: 'script-ready',
      progress: 1,
      message: 'Kịch bản sẵn sàng',
      outputPath: generated.outputPath,
      scriptDownloadUrl: `/api/workflows/${jobId}/${code}/script`,
    });
    return generated;
  } catch (error) {
    appendJobLog(jobId, `[${definition.label}] ${error.stack || error.message}`);
    setWorkflowLanguage(jobId, code, {
      stage: 'failed',
      progress: 1,
      message: error.message,
      error: error.message,
    });
    return null;
  }
};

const runWorkflowLanguage = async (
  jobId,
  koreanScript,
  code,
  rewriteMode,
  processingMode,
  translationProvider,
) => {
  const definition = LANGUAGE_DEFINITIONS[code];
  try {
    if (rewriteMode === 'gpt-korea') {
      setWorkflowLanguage(jobId, code, {
        stage: 'translating',
        progress: 0.1,
        message: 'Dùng thẳng kịch bản tiếng Hàn làm mẫu · GPT-5.6 Terra sẽ rewrite',
      });
      return completeWorkflowLanguage(
        jobId,
        code,
        rewriteMode,
        {translation: koreanScript, model: 'korean-source', provider: translationProvider},
        processingMode,
        translationProvider,
      );
    }
    setWorkflowLanguage(jobId, code, {
      stage: 'translating',
      progress: 0.1,
      message:
        code === 'korea'
          ? 'Đang chuẩn bị kịch bản nguồn tiếng Hàn'
          : `GPT-5.6 Terra đang dịch sang ${definition.label} qua ${translationProvider === 'openai' ? 'OpenAI' : 'Kie'}`,
    });
    const translated = await translatePrayerScript(koreanScript, code, {
      provider: translationProvider,
    });
    return completeWorkflowLanguage(
      jobId,
      code,
      rewriteMode,
      translated,
      processingMode,
      translationProvider,
    );
  } catch (error) {
    appendJobLog(jobId, `[${definition.label}] ${error.stack || error.message}`);
    setWorkflowLanguage(jobId, code, {
      stage: 'failed',
      progress: 1,
      message: error.message,
      error: error.message,
    });
    return null;
  }
};

const runBatchTranslationWorkflow = async (
  jobId,
  koreanScript,
  selectedLanguages,
  rewriteModes,
  processingMode,
  translationProvider,
) => {
  for (const code of selectedLanguages) {
    setWorkflowLanguage(jobId, code, {
      stage: 'translating',
      progress: code === 'korea' ? 0.15 : 0.1,
      message: code === 'korea'
        ? 'Đang chuẩn bị kịch bản nguồn tiếng Hàn'
        : 'Đang gửi vào OpenAI Batch',
    });
  }
  try {
    const translations = await translatePrayerScriptsBatch(koreanScript, selectedLanguages, {
      provider: translationProvider,
      onCreated: (batch) => {
        updateJob(jobId, {batchId: batch.id, message: `OpenAI Batch ${batch.id} đang xử lý`});
        for (const code of selectedLanguages.filter((item) => item !== 'korea')) {
          setWorkflowLanguage(jobId, code, {
            message: `OpenAI Batch đang chờ xử lý · ${batch.id}`,
          });
        }
      },
      onProgress: (batch) => {
        const counts = batch.request_counts || {};
        const summary = `${counts.completed || 0}/${counts.total || selectedLanguages.length - Number(selectedLanguages.includes('korea'))}`;
        updateJob(jobId, {message: `OpenAI Batch ${batch.status} · ${summary}`});
        for (const code of selectedLanguages.filter((item) => item !== 'korea')) {
          setWorkflowLanguage(jobId, code, {
            progress: batch.status === 'in_progress' ? 0.25 : 0.15,
            message: `OpenAI Batch: ${batch.status} · ${summary}`,
          });
        }
      },
    });
    return Promise.all(
      selectedLanguages.map((code) =>
        completeWorkflowLanguage(
          jobId,
          code,
          rewriteModes[code] || 'translation',
          translations[code],
          processingMode,
          translationProvider,
        ),
      ),
    );
  } catch (error) {
    appendJobLog(jobId, error.stack || error.message);
    for (const code of selectedLanguages) {
      setWorkflowLanguage(jobId, code, {
        stage: 'failed',
        progress: 1,
        message: error.message,
        error: error.message,
      });
    }
    return selectedLanguages.map(() => null);
  }
};

export const runScriptWorkflow = async (
  jobId,
  koreanScript,
  selectedLanguages,
  rewriteModes,
  {processingMode = 'standard', translationProvider = 'openai'} = {},
) => {
  updateJob(jobId, {
    status: 'running',
    message: processingMode === 'batch'
      ? 'Đang chuẩn bị OpenAI Batch'
      : 'Đang dịch và xử lý kịch bản theo từng ngôn ngữ',
  });
  let results;
  if (processingMode === 'batch') {
    // gpt-korea bỏ qua bước dịch nên không đưa vào batch dịch; xử lý trực tiếp song song.
    const directKoreaLanguages = selectedLanguages.filter(
      (code) => (rewriteModes[code] || 'translation') === 'gpt-korea',
    );
    const batchLanguages = selectedLanguages.filter(
      (code) => (rewriteModes[code] || 'translation') !== 'gpt-korea',
    );
    const [batchResults, directResults] = await Promise.all([
      batchLanguages.length
        ? runBatchTranslationWorkflow(
            jobId,
            koreanScript,
            batchLanguages,
            rewriteModes,
            processingMode,
            translationProvider,
          )
        : Promise.resolve([]),
      Promise.all(
        directKoreaLanguages.map((code) =>
          runWorkflowLanguage(
            jobId,
            koreanScript,
            code,
            'gpt-korea',
            processingMode,
            translationProvider,
          ),
        ),
      ),
    ]);
    results = [...batchResults, ...directResults];
  } else {
    results = await Promise.all(
      selectedLanguages.map((code) =>
        runWorkflowLanguage(
          jobId,
          koreanScript,
          code,
          rewriteModes[code] || 'translation',
          processingMode,
          translationProvider,
        ),
      ),
    );
  }
  const successful = results.filter(Boolean).length;
  updateJob(jobId, {
    status: 'completed',
    progress: 1,
    message:
      successful === selectedLanguages.length
        ? 'Tất cả kịch bản đã sẵn sàng'
        : `Hoàn tất ${successful}/${selectedLanguages.length} ngôn ngữ`,
  });
};
