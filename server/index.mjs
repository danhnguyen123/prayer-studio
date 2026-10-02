import path from 'node:path';
import {mkdirSync, readFileSync} from 'node:fs';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {pipeline as streamPipeline} from 'node:stream/promises';
import express from 'express';
import multer from 'multer';

const projectRoot = path.resolve(import.meta.dirname, '..');
try {
  process.loadEnvFile(path.join(projectRoot, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') console.warn(`Không đọc được .env: ${error.message}`);
}

const [{DEFAULT_PATHS, LANGUAGE_DEFINITIONS, PROJECT_ROOT}, {translatePrayerScript}, pipeline, jobs, batchRenderer, {prepVoiceover}, {startUploadCleanup}, awsStorage] =
  await Promise.all([
    import('./constants.mjs'),
    import('./translation-provider.mjs'),
    import('./script-pipeline.mjs'),
    import('./job-store.mjs'),
    import('./aws-batch-render.mjs'),
    import('./voiceover-prep.mjs'),
    import('./upload-cleanup.mjs'),
    import('./aws-storage.mjs'),
  ]);

const app = express();
const port = Number(process.env.APP_PORT || 4300);
// Trong container phải nghe 0.0.0.0 để cổng publish (-p) và public IP truy cập được;
// local mặc định 127.0.0.1 cho an toàn. Đặt APP_HOST để ghi đè.
const host =
  process.env.APP_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const uploadRoot = path.resolve(process.env.UPLOAD_ROOT || path.join(PROJECT_ROOT, 'workspace', 'uploads'));
mkdirSync(uploadRoot, {recursive: true});
startUploadCleanup({
  uploadRoot,
  retentionHours: Number(process.env.UPLOAD_RETENTION_HOURS || 24),
  intervalHours: Number(process.env.UPLOAD_CLEANUP_INTERVAL_HOURS || 1),
});
const completedVideoRoot = process.env.COMPLETED_VIDEO_ROOT?.trim();
if (completedVideoRoot) {
  mkdirSync(completedVideoRoot, {recursive: true});
  startUploadCleanup({
    uploadRoot: completedVideoRoot,
    retentionHours: Number(process.env.COMPLETED_VIDEO_RETENTION_HOURS || 168),
    intervalHours: Number(process.env.UPLOAD_CLEANUP_INTERVAL_HOURS || 168),
  });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadRoot),
    filename: (_request, file, callback) =>
      callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: {fileSize: 1024 * 1024 * 1024},
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const valid =
      (file.fieldname === 'audio' && extension === '.mp3') ||
      (file.fieldname === 'srt' && extension === '.srt');
    callback(valid ? null : new Error('Chỉ chấp nhận file MP3 và SRT.'), valid);
  },
});

const validateLanguages = (languages) => {
  const selected = Array.isArray(languages) ? languages : Object.keys(LANGUAGE_DEFINITIONS);
  const unique = [...new Set(selected)];
  if (!unique.length) throw new Error('Hãy chọn ít nhất một ngôn ngữ.');
  for (const code of unique) {
    if (!LANGUAGE_DEFINITIONS[code]) throw new Error(`Ngôn ngữ không hỗ trợ: ${code}`);
  }
  return unique;
};

const validateRewriteModes = (languages, value) => {
  const modes = value && typeof value === 'object' ? value : {};
  const allowed = new Set(['translation', 'deepseek', 'gpt', 'gpt-korea']);
  return Object.fromEntries(
    languages.map((code) => {
      const mode = String(modes[code] || 'translation');
      if (!allowed.has(mode)) throw new Error(`Chế độ rewrite không hợp lệ: ${mode}`);
      return [code, mode];
    }),
  );
};

const validateTranslationProvider = (value) => {
  const provider = String(value || 'openai').toLowerCase();
  if (!['openai', 'kie'].includes(provider)) {
    throw new Error(`Provider dịch không hợp lệ: ${provider}`);
  }
  return provider;
};

const validateProcessingMode = (value, provider) => {
  const mode = String(value || 'standard').toLowerCase();
  if (!['standard', 'batch'].includes(mode)) {
    throw new Error(`Processing mode không hợp lệ: ${mode}`);
  }
  if (mode === 'batch' && provider !== 'openai') {
    throw new Error('Batch processing chỉ hỗ trợ OpenAI API chính thức.');
  }
  return mode;
};

const hasOpenAIApiKey = () => {
  if (process.env.OPENAI_API_KEY?.trim()) return true;
  try {
    const keyFile = path.resolve(PROJECT_ROOT, process.env.OPENAI_API_FILE || 'API_OPENAI.txt');
    return readFileSync(keyFile, 'utf8')
      .split(/\r?\n/)
      .some((line) => line.trim() && !line.trim().startsWith('#'));
  } catch {
    return false;
  }
};

const hasKieApiKey = () => {
  if (process.env.KIE_API_KEY?.trim()) return true;
  try {
    const keyFile = path.resolve(PROJECT_ROOT, process.env.KIE_API_FILE || 'API_KIE.txt');
    return readFileSync(keyFile, 'utf8')
      .split(/\r?\n/)
      .some((line) => line.trim() && !line.trim().startsWith('#'));
  } catch {
    return false;
  }
};

// Basic Auth — bật khi đặt APP_BASIC_AUTH_USER + APP_BASIC_AUTH_PASS trong .env.
// Bắt buộc khi mở web ra public IP:port để tránh người lạ dùng và tiêu tiền API/AWS.
const basicAuthUser = process.env.APP_BASIC_AUTH_USER;
const basicAuthPass = process.env.APP_BASIC_AUTH_PASS;
if (basicAuthUser && basicAuthPass) {
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${basicAuthUser}:${basicAuthPass}`).toString('base64')}`,
  );
  app.use((request, response, next) => {
    const provided = Buffer.from(String(request.headers.authorization || ''));
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      next();
      return;
    }
    response.setHeader('WWW-Authenticate', 'Basic realm="Prayer Studio", charset="UTF-8"');
    response.status(401).send('Cần đăng nhập.');
  });
} else {
  console.warn(
    '[bảo mật] APP_BASIC_AUTH_USER/PASS chưa đặt — web KHÔNG có xác thực. Đừng mở ra public khi chưa bật.',
  );
}

app.use(express.json({limit: '8mb'}));

app.get('/api/status', (_request, response) => {
  response.json({
    ok: true,
    translationConfigured: hasOpenAIApiKey(),
    translationProvider: 'OpenAI Responses API',
    defaultTranslationProvider: 'openai',
    providers: {
      openai: {configured: hasOpenAIApiKey(), label: 'OpenAI chính thức'},
      kie: {configured: hasKieApiKey(), label: 'Kie dự phòng'},
    },
    batchSupported: true,
    translationModel: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    translationReasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'medium',
    batchConfigured: batchRenderer.isBatchConfigured(),
    batchRegion: process.env.AWS_BATCH_REGION || process.env.AWS_REGION || 'ap-southeast-1',
    languages: Object.entries(LANGUAGE_DEFINITIONS).map(([code, value]) => ({
      code,
      label: value.label,
      config: value.config,
    })),
    defaults: DEFAULT_PATHS,
  });
});

app.post('/api/translate', async (request, response, next) => {
  try {
    const koreanScript = String(request.body?.koreanScript || '').trim();
    if (koreanScript.length < 20) throw new Error('Kịch bản tiếng Hàn quá ngắn.');
    const selectedLanguages = validateLanguages(request.body?.languages);
    const translationProvider = validateTranslationProvider(request.body?.translationProvider);
    const results = await Promise.all(
      selectedLanguages.map(async (code) => {
        const translated = await translatePrayerScript(koreanScript, code, {
          provider: translationProvider,
        });
        const saved = await pipeline.persistTranslation(code, translated.translation);
        return [code, {...translated, saved}];
      }),
    );
    response.json({translations: Object.fromEntries(results)});
  } catch (error) {
    next(error);
  }
});

app.post('/api/workflows', (request, response, next) => {
  try {
    const koreanScript = String(request.body?.koreanScript || '').trim();
    if (koreanScript.length < 20) throw new Error('Kịch bản tiếng Hàn quá ngắn.');
    const selectedLanguages = validateLanguages(request.body?.languages);
    const rewriteModes = validateRewriteModes(selectedLanguages, request.body?.rewriteModes);
    const translationProvider = validateTranslationProvider(request.body?.translationProvider);
    const processingMode = validateProcessingMode(
      request.body?.processingMode,
      translationProvider,
    );
    const languageStates = Object.fromEntries(
      selectedLanguages.map((code) => [
        code,
        {
          code,
          label: LANGUAGE_DEFINITIONS[code].label,
          stage: 'queued',
          progress: 0,
          message: 'Đang chờ',
          rewriteMode: rewriteModes[code],
          translationProvider,
          processingMode,
          assets: null,
        },
      ]),
    );
    const job = jobs.createJob('prayer-workflow', {
      selectedLanguages,
      rewriteModes,
      translationProvider,
      processingMode,
      languages: languageStates,
      message: 'Đang khởi tạo workflow',
    });
    pipeline.runScriptWorkflow(job.id, koreanScript, selectedLanguages, rewriteModes, {
      translationProvider,
      processingMode,
    });
    response.status(202).json({jobId: job.id});
  } catch (error) {
    next(error);
  }
});

app.post('/api/workflows/skip-script', (request, response, next) => {
  try {
    const selectedLanguages = validateLanguages(request.body?.languages);
    const languageStates = Object.fromEntries(
      selectedLanguages.map((code) => [
        code,
        {
          code,
          label: LANGUAGE_DEFINITIONS[code].label,
          stage: 'script-ready',
          progress: 1,
          message: 'Đã bỏ qua tạo kịch bản · sẵn sàng upload MP3/SRT cũ',
          rewriteMode: 'translation',
          skippedScript: true,
          assets: null,
        },
      ]),
    );
    const job = jobs.createJob('prayer-workflow', {
      status: 'completed',
      progress: 1,
      selectedLanguages,
      rewriteModes: Object.fromEntries(
        selectedLanguages.map((code) => [code, 'translation']),
      ),
      skippedScript: true,
      languages: languageStates,
      message: 'Đã bỏ qua bước tạo kịch bản',
    });
    response.status(201).json({jobId: job.id});
  } catch (error) {
    next(error);
  }
});

app.get('/api/workflows/:jobId/:language/script', (request, response, next) => {
  try {
    const workflow = jobs.getJob(request.params.jobId);
    const language = workflow?.languages?.[request.params.language];
    if (!workflow || !language?.outputPath) {
      throw new Error('Kịch bản chưa sẵn sàng.');
    }
    response.download(
      language.outputPath,
      `${request.params.language}-prayer-script.txt`,
    );
  } catch (error) {
    next(error);
  }
});

app.get('/api/workflows/:jobId/:language/voiceover', (request, response, next) => {
  try {
    const workflow = jobs.getJob(request.params.jobId);
    const language = workflow?.languages?.[request.params.language];
    if (!workflow || !language?.outputPath) {
      throw new Error('Kịch bản chưa sẵn sàng.');
    }
    const maxChars = Math.max(
      200,
      Math.min(5000, Number(request.query.maxChars) || 950),
    );
    const scriptText = readFileSync(language.outputPath, 'utf8');
    const paragraphs = prepVoiceover(scriptText, maxChars);
    const body = paragraphs.join('\n\n') + '\n';
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${request.params.language}-voiceover.txt"`,
    );
    response.send(body);
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/workflows/:jobId/:language/assets',
  upload.fields([
    {name: 'audio', maxCount: 1},
    {name: 'srt', maxCount: 1},
  ]),
  (request, response, next) => {
    try {
      const workflow = jobs.getJob(request.params.jobId);
      const language = workflow?.languages?.[request.params.language];
      if (!workflow || !language) throw new Error('Workflow hoặc ngôn ngữ không hợp lệ.');
      const audio = request.files?.audio?.[0];
      const srt = request.files?.srt?.[0];
      if (!audio || !srt) throw new Error('Hãy chọn cả file MP3 và SRT.');
      const assets = {
        audioPath: audio.path,
        audioName: audio.originalname,
        srtPath: srt.path,
        srtName: srt.originalname,
      };
      jobs.mutateJob(workflow.id, (current) => {
        current.languages[request.params.language] = {
          ...current.languages[request.params.language],
          assets,
          message: 'MP3 và SRT đã được upload',
        };
      });
      response.json({ok: true, assets});
    } catch (error) {
      next(error);
    }
  },
);

app.post('/api/batch/render', (request, response, next) => {
  try {
    if (!batchRenderer.isBatchConfigured()) {
      throw new Error('AWS Batch chưa cấu hình. Kiểm tra AWS_BATCH_BUCKET/JOB_QUEUE/JOB_DEFINITION.');
    }
    const workflow = jobs.getJob(String(request.body?.workflowId || ''));
    if (!workflow || workflow.type !== 'prayer-workflow') {
      throw new Error('Workflow không tồn tại.');
    }
    const selectedLanguages = validateLanguages(request.body?.languages).filter(
      (code) => workflow.languages[code],
    );
    for (const code of selectedLanguages) {
      if (!workflow.languages[code]?.assets) {
        throw new Error(`${LANGUAGE_DEFINITIONS[code].label}: chưa upload MP3/SRT.`);
      }
    }
    const languageStates = Object.fromEntries(
      selectedLanguages.map((code) => [
        code,
        {code, stage: 'queued', progress: 0, message: 'Đang chờ AWS Batch worker 4 vCPU'},
      ]),
    );
    const job = jobs.createJob('aws-batch-ffmpeg-render', {
      workflowId: workflow.id,
      languages: languageStates,
      selectedLanguages,
    });
    const options = {...DEFAULT_PATHS, ...request.body};
    batchRenderer.runParallelBatchRenderJob({
      jobId: job.id,
      workflowId: workflow.id,
      languages: selectedLanguages,
      options,
    });
    response.status(202).json({jobId: job.id});
  } catch (error) {
    next(error);
  }
});

app.post('/api/batch/render/:jobId/:language/stop', async (request, response, next) => {
  try {
    const job = await batchRenderer.stopBatchRenderLanguage({
      jobId: request.params.jobId,
      code: request.params.language,
    });
    response.json(job);
  } catch (error) {
    next(error);
  }
});

app.post('/api/batch/render/:jobId/stop', async (request, response, next) => {
  try {
    response.json(await batchRenderer.stopAllBatchRenders(request.params.jobId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/batch/render/:jobId/:language/download', async (request, response, next) => {
  try {
    const job = jobs.getJob(request.params.jobId);
    const language = job?.languages?.[request.params.language];
    if (!job || job.type !== 'aws-batch-ffmpeg-render' || !language?.outputKey) {
      response.status(404).json({error: 'Video render không tồn tại hoặc chưa hoàn tất.'});
      return;
    }
    if (language.localOutputPath) {
      try {
        response.attachment(`${request.params.language}-prayer.mp4`);
        await streamPipeline(
          (await import('node:fs')).createReadStream(language.localOutputPath),
          response,
        );
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const config = batchRenderer.batchConfig();
    const object = await awsStorage.getObject({
      bucketName: config.bucketName,
      objectKey: language.outputKey,
      region: config.region,
    });
    response.type('video/mp4');
    response.attachment(`${request.params.language}-prayer.mp4`);
    if (object.ContentLength) response.setHeader('Content-Length', String(object.ContentLength));
    await streamPipeline(object.Body, response);
  } catch (error) {
    next(error);
  }
});

app.get('/api/workflows/current', (_request, response) => {
  response.json(jobs.listJobs({type: 'prayer-workflow'})[0] || null);
});

app.get('/api/render-jobs', (_request, response) => {
  response.json(jobs.listJobs({type: 'aws-batch-ffmpeg-render'}));
});

app.post('/api/generate', (request, response, next) => {
  try {
    const selectedLanguages = validateLanguages(request.body?.languages);
    const job = jobs.createJob('script-generation', {selectedLanguages});
    pipeline.runGenerationJob(job.id, selectedLanguages);
    response.status(202).json({jobId: job.id});
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:jobId', (request, response) => {
  const job = jobs.getJob(request.params.jobId);
  if (!job) {
    response.status(404).json({error: 'Không tìm thấy job.'});
    return;
  }
  response.json(job);
});

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(PROJECT_ROOT, 'dist');
  app.use(express.static(distDir));
  // SPA fallback (Express 5 không chấp nhận app.get('*') nên dùng middleware).
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) {
      next();
      return;
    }
    response.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const {createServer: createViteServer} = await import('vite');
  const vite = await createViteServer({
    root: path.join(PROJECT_ROOT, 'web'),
    server: {middlewareMode: true, hmr: {port: 24679}},
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(400).json({error: error.message || 'Đã xảy ra lỗi.'});
});

app.listen(port, host, () => {
  console.log(`Prayer Studio: http://${host}:${port}`);
});
