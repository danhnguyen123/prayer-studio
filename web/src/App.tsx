import {useEffect, useMemo, useState} from 'react';
import {Player} from '@remotion/player';
import {PrayerVideo} from '../../remotion/PrayerVideo';
import type {PrayerVideoProps} from '../../remotion/schema';
import {api, type Job, type LanguageJobState, waitForJob} from './api';

type Language = {code: string; label: string; config: string};
type Status = {
  ok: boolean;
  translationConfigured: boolean;
  translationProvider: string;
  translationModel: string;
  translationReasoningEffort: string;
  defaultTranslationProvider: 'openai' | 'kie';
  providers: Record<'openai' | 'kie', {configured: boolean; label: string}>;
  batchSupported: boolean;
  lambdaConfigured: boolean;
  lambdaRegion: string;
  languages: Language[];
  defaults: {
    videoDir: string;
    imageDir: string;
    musicPath?: string;
    introSeconds?: number;
    introText?: string;
    musicVolume?: number;
    musicIntroVolume?: number;
  };
};
type LocalFiles = {audio?: File; srt?: File};

const stageLabels: Record<string, string> = {
  queued: 'Đang chờ', translating: 'GPT Terra đang dịch', generating: 'Đang rewrite',
  'script-ready': 'Kịch bản sẵn sàng', planning: 'Đang tạo timeline',
  'uploading-media': 'Đang tải media lên S3', 'starting-lambda': 'Đang khởi chạy Lambda',
  rendering: 'Lambda đang render', completed: 'Video sẵn sàng', failed: 'Có lỗi',
};

const formatBytes = (bytes = 0) => {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
};

const StepLabel = ({number, children}: {number: string; children: React.ReactNode}) => (
  <div className="step-label"><span>{number}</span><h2>{children}</h2></div>
);

export const App = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [koreanScript, setKoreanScript] = useState('');
  const [selectedLanguages, setSelectedLanguages] = useState(['france', 'poland', 'germany', 'italia', 'korea']);
  const [rewriteModes, setRewriteModes] = useState<Record<string, string>>({
    france: 'gpt-korea', poland: 'gpt-korea', germany: 'gpt-korea', italia: 'gpt-korea', korea: 'gpt-korea',
  });
  const [translationProvider, setTranslationProvider] = useState<'openai' | 'kie'>('openai');
  const [processingMode, setProcessingMode] = useState<'standard' | 'batch'>('standard');
  const [workflow, setWorkflow] = useState<Job | null>(null);
  const [lambdaJob, setLambdaJob] = useState<Job | null>(null);
  const [files, setFiles] = useState<Record<string, LocalFiles>>({});
  const [previews, setPreviews] = useState<Record<string, PrayerVideoProps>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [mediaOptions, setMediaOptions] = useState({
    videoDir: '', imageDir: '', videoCount: 12, seed: 'prayer-studio',
    introSeconds: 8, musicPath: '', musicVolume: 0, musicIntroVolume: 0.2,
    videosPerCycle: 10, imagesPerCycle: 5,
  });
  const [introTexts, setIntroTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    api<Status>('/api/status').then((nextStatus) => {
      setStatus(nextStatus);
      setMediaOptions((current) => ({
        ...current,
        videoDir: nextStatus.defaults.videoDir,
        imageDir: nextStatus.defaults.imageDir,
        musicPath: nextStatus.defaults.musicPath ?? current.musicPath,
        introSeconds: nextStatus.defaults.introSeconds ?? current.introSeconds,
        musicVolume: nextStatus.defaults.musicVolume ?? current.musicVolume,
        musicIntroVolume: nextStatus.defaults.musicIntroVolume ?? current.musicIntroVolume,
      }));
    }).catch((nextError) => setError(nextError.message));
  }, []);

  const workflowLanguages = useMemo(
    () => workflow?.selectedLanguages || selectedLanguages,
    [workflow, selectedLanguages],
  );
  const setActionBusy = (key: string, value: boolean) => setBusy((current) => ({...current, [key]: value}));
  const toggleLanguage = (code: string) => setSelectedLanguages((current) =>
    current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
  );

  const startWorkflow = async () => {
    setError(''); setLambdaJob(null); setPreviews({}); setFiles({}); setActionBusy('workflow', true);
    try {
      const {jobId} = await api<{jobId: string}>('/api/workflows', {
        method: 'POST', body: JSON.stringify({
          koreanScript,
          languages: selectedLanguages,
          rewriteModes,
          translationProvider,
          processingMode,
        }),
      });
      await waitForJob(jobId, setWorkflow);
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setActionBusy('workflow', false); }
  };

  const skipScriptStep = async () => {
    setError(''); setLambdaJob(null); setPreviews({}); setFiles({}); setActionBusy('workflow', true);
    try {
      const {jobId} = await api<{jobId: string}>('/api/workflows/skip-script', {
        method: 'POST', body: JSON.stringify({languages: selectedLanguages}),
      });
      setWorkflow(await api<Job>(`/api/jobs/${jobId}`));
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setActionBusy('workflow', false); }
  };

  const createPreview = async (code: string) => {
    if (!workflow) return;
    setError(''); setActionBusy(`preview-${code}`, true);
    try {
      const plan = await api<PrayerVideoProps>(`/api/workflows/${workflow.id}/${code}/preview`, {
        method: 'POST', body: JSON.stringify({...mediaOptions, introText: introTexts[code] || ''}),
      });
      setPreviews((current) => ({...current, [code]: plan}));
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setActionBusy(`preview-${code}`, false); }
  };

  const uploadAssets = async (code: string) => {
    const pair = files[code];
    if (!workflow || !pair?.audio || !pair.srt) return;
    setError(''); setActionBusy(`upload-${code}`, true);
    try {
      const data = new FormData(); data.append('audio', pair.audio); data.append('srt', pair.srt);
      await api(`/api/workflows/${workflow.id}/${code}/assets`, {method: 'POST', body: data});
      setWorkflow(await api<Job>(`/api/jobs/${workflow.id}`));
      await createPreview(code);
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setActionBusy(`upload-${code}`, false); }
  };

  const renderLanguages = async (languages: string[]) => {
    if (!workflow || languages.length === 0) return;
    setError(''); setActionBusy('lambda', true);
    try {
      const {jobId} = await api<{jobId: string}>('/api/lambda/render', {
        method: 'POST', body: JSON.stringify({workflowId: workflow.id, languages, ...mediaOptions, introTexts}),
      });
      await waitForJob(jobId, setLambdaJob);
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setActionBusy('lambda', false); }
  };

  const renderableLanguages = workflowLanguages.filter((code) => workflow?.languages?.[code]?.assets);
  const workflowActive = workflow && workflow.status !== 'completed';

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="brand-mark" aria-hidden="true"><span /><span /></div>
        <div>
          <p className="eyebrow">LOCAL PRODUCTION WORKSPACE</p><h1>Prayer Studio</h1>
        </div>
        <div className="status-stack">
          <div className={`status-pill ${status?.providers?.openai.configured ? 'ready' : 'warning'}`}><span /> OpenAI {status?.providers?.openai.configured ? 'sẵn sàng' : 'chưa có API key'}</div>
          <div className={`status-pill ${status?.lambdaConfigured ? 'ready' : 'warning'}`}><span /> Lambda {status?.lambdaConfigured ? 'sẵn sàng' : 'chưa cấu hình'}</div>
          <div className="model-name">{status?.translationModel || 'Đang kiểm tra...'} · medium · {status?.lambdaRegion || 'AWS'}</div>
        </div>
      </header>

      {error && <div className="alert" role="alert"><strong>Cần xử lý:</strong> {error}<button onClick={() => setError('')} aria-label="Đóng thông báo">×</button></div>}

      <main>
        {!workflow ? (
          <section className="panel source-panel">
            <StepLabel number="01">Dịch kịch bản nguồn</StepLabel>
            <div className="language-row">
              {status?.languages.map((language) => (
                <label key={language.code} className={`language-chip ${selectedLanguages.includes(language.code) ? 'active' : ''}`}>
                  <input type="checkbox" checked={selectedLanguages.includes(language.code)} onChange={() => toggleLanguage(language.code)} />{language.label}
                </label>
              ))}
            </div>
            <div className="api-controls">
              <label>
                <span>GPT provider</span>
                <select
                  className="mode-select"
                  value={translationProvider}
                  onChange={(event) => {
                    const provider = event.target.value as 'openai' | 'kie';
                    setTranslationProvider(provider);
                    if (provider === 'kie') setProcessingMode('standard');
                  }}
                >
                  <option value="openai" disabled={!status?.providers?.openai.configured}>OpenAI chính thức · Mặc định</option>
                  <option value="kie" disabled={!status?.providers?.kie.configured}>Kie · Dự phòng</option>
                </select>
              </label>
              <label>
                <span>Processing</span>
                <select
                  className="mode-select"
                  value={processingMode}
                  disabled={translationProvider !== 'openai'}
                  onChange={(event) => setProcessingMode(event.target.value as 'standard' | 'batch')}
                >
                  <option value="standard">Standard · Có kết quả ngay</option>
                  <option value="batch">Batch · Tiết kiệm 50%</option>
                </select>
              </label>
              <small>{processingMode === 'batch' ? 'Batch chạy bất đồng bộ và có thể mất đến 24 giờ.' : 'Mỗi ngôn ngữ được xử lý ngay bằng Responses API.'}</small>
            </div>
            <div className="rewrite-choice-list">
              {status?.languages.filter((language) => selectedLanguages.includes(language.code)).map((language) => (
                <div className="rewrite-choice-row" key={language.code}>
                  <strong>{language.label}</strong>
                  <select
                    className="mode-select"
                    aria-label={`Cách tạo kịch bản ${language.label}`}
                    value={rewriteModes[language.code]}
                    onChange={(event) => setRewriteModes((current) => ({...current, [language.code]: event.target.value}))}
                  >
                    <option value="translation">Dùng nguyên bản dịch</option>
                    <option value="deepseek">Rewrite · DeepSeek v4 Pro</option>
                    <option value="gpt">Rewrite từ bản dịch · GPT‑5.6 Terra medium</option>
                    <option value="gpt-korea">Rewrite thẳng từ tiếng Hàn · GPT‑5.6 Terra medium · Mặc định</option>
                  </select>
                </div>
              ))}
            </div>
            <textarea value={koreanScript} onChange={(event) => setKoreanScript(event.target.value)} placeholder="여기에 한국어 기도문을 붙여넣으세요…" spellCheck={false} />
            <div className="actions">
              <button className="primary" disabled={busy.workflow || koreanScript.trim().length < 20 || selectedLanguages.length === 0} onClick={startWorkflow}>
                {busy.workflow ? 'Đang khởi tạo…' : 'Dịch & tạo kịch bản'}
              </button>
              <button className="ghost skip-script-button" disabled={busy.workflow || selectedLanguages.length === 0} onClick={skipScriptStep}>
                Bỏ qua · dùng MP3/SRT cũ
              </button>
              <span>{koreanScript.length.toLocaleString('vi-VN')} ký tự</span>
            </div>
          </section>
        ) : (
          <>
            <section className="panel workflow-panel">
              <div className="workflow-heading">
                <div><StepLabel number="02">Tiến độ theo ngôn ngữ</StepLabel><p className="section-copy">Khi kịch bản sẵn sàng, tải file TXT và dùng nó để tạo MP3/SRT bên ngoài.</p></div>
                <div className="workflow-actions"><strong>{Math.round(workflow.progress * 100)}%</strong><button className="ghost" disabled={Boolean(workflowActive)} onClick={() => {setWorkflow(null); setLambdaJob(null); setPreviews({}); setFiles({});}}>Tạo workflow mới</button></div>
              </div>
              <div className="progress-track"><span style={{width: `${workflow.progress * 100}%`}} /></div>
              <div className="language-workflows">
                {workflowLanguages.map((code) => {
                  const definition = status?.languages.find((item) => item.code === code);
                  const lane = workflow.languages?.[code] as LanguageJobState | undefined;
                  const renderLane = lambdaJob?.languages?.[code];
                  const preview = previews[code];
                  const pair = files[code] || {};
                  const scriptReady = lane?.stage === 'script-ready';
                  const assetsReady = Boolean(lane?.assets);
                  return (
                    <article className="language-card" key={code}>
                      <div className="language-card-head"><div><span className={`stage-dot ${lane?.stage === 'failed' ? 'failed' : scriptReady ? 'done' : 'working'}`} /><strong>{definition?.label || lane?.label || code}</strong><small className="mode-label">{lane?.skippedScript ? 'Bỏ qua kịch bản · dùng media cũ' : `${lane?.rewriteMode === 'deepseek' ? 'Rewrite · DeepSeek v4 Pro' : lane?.rewriteMode === 'gpt' ? 'Rewrite · GPT‑5.6 Terra medium' : lane?.rewriteMode === 'gpt-korea' ? 'Rewrite từ tiếng Hàn · GPT‑5.6 Terra' : 'Dùng bản dịch'} · ${lane?.translationProvider === 'kie' ? 'Kie' : 'OpenAI'}${lane?.processingMode === 'batch' ? ' Batch' : ''}`}</small></div><span className={`stage-badge ${lane?.stage || 'queued'}`}>{stageLabels[lane?.stage || 'queued'] || lane?.message}</span></div>
                      <div className="lane-progress"><span style={{width: `${(lane?.progress || 0) * 100}%`}} /></div>
                      <p className={lane?.stage === 'failed' ? 'lane-message error-text' : 'lane-message'}>{lane?.message || 'Đang chờ'}</p>
                      {scriptReady && (
                        <div className="production-zone">
                          <div className="script-ready-line"><span>✓ {lane.skippedScript ? 'Sẵn sàng dùng lại MP3/SRT cũ' : 'Kịch bản đã hoàn tất'}</span>{lane.scriptDownloadUrl && <a href={lane.scriptDownloadUrl} download>Download TXT</a>}{!lane.skippedScript && lane.outputPath && <a href={`/api/workflows/${workflow.id}/${code}/voiceover`} download>Tải voiceover (chia phần)</a>}</div>
                          <div className="production-inputs">
                            <div className="upload-grid">
                              <label><span>Voiceover MP3</span><input type="file" accept="audio/mpeg,.mp3" onChange={(event) => setFiles((current) => ({...current, [code]: {...current[code], audio: event.target.files?.[0]}}))} /><small>{pair.audio?.name || lane.assets?.audioName || 'Chưa chọn file'}</small></label>
                              <label><span>Phụ đề SRT</span><input type="file" accept=".srt,application/x-subrip" onChange={(event) => setFiles((current) => ({...current, [code]: {...current[code], srt: event.target.files?.[0]}}))} /><small>{pair.srt?.name || lane.assets?.srtName || 'Chưa chọn file'}</small></label>
                            </div>
                            <label className="verse-inline"><span>Câu Kinh Thánh intro ({mediaOptions.introSeconds}s · 4–6 dòng)</span><textarea value={introTexts[code] || ''} onChange={(event) => setIntroTexts((current) => ({...current, [code]: event.target.value}))} rows={3} placeholder={'“Hãy đến cùng Ta, hỡi những ai mệt mỏi và gánh nặng,\nvà Ta sẽ cho các con được nghỉ ngơi.”\n— Mátthêu 11:28'} spellCheck={false} /></label>
                          </div>
                          <div className="card-actions">
                            <button className="secondary" disabled={busy[`upload-${code}`] || !pair.audio || !pair.srt} onClick={() => uploadAssets(code)}>{busy[`upload-${code}`] ? 'Đang upload…' : assetsReady ? 'Upload lại MP3 + SRT' : 'Upload MP3 + SRT'}</button>
                            <button className="ghost" disabled={!assetsReady || busy[`preview-${code}`]} onClick={() => createPreview(code)}>{busy[`preview-${code}`] ? 'Đang tạo…' : 'Preview Remotion'}</button>
                            <button className="primary" disabled={!assetsReady || !status?.lambdaConfigured || busy.lambda} onClick={() => renderLanguages([code])}>Build & Render</button>
                          </div>
                          {preview && <div className="inline-preview"><Player component={PrayerVideo} inputProps={preview} durationInFrames={preview.durationInFrames} compositionWidth={1920} compositionHeight={1080} fps={30} controls style={{width: '100%', aspectRatio: '16 / 9'}} /><div className="preview-meta"><span>{Math.round(preview.audioDurationSeconds / 60)} phút</span><span>{preview.selectedVideos.length} video</span><span>{preview.captions.length} caption</span></div></div>}
                        </div>
                      )}
                      {renderLane && <div className={`render-status ${renderLane.stage}`}><div><strong>{stageLabels[renderLane.stage] || renderLane.message}</strong><span>{renderLane.message} · {Math.round(renderLane.progress * 100)}%</span></div>{renderLane.downloadUrl && <a href={renderLane.downloadUrl} download>Download video {formatBytes(renderLane.outputSizeInBytes)}</a>}</div>}
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="panel render-settings">
              <div><StepLabel number="03">Nguồn hình & Lambda Render</StepLabel><p className="section-copy">Các ngôn ngữ được gửi đồng thời lên Remotion Lambda. Media được dùng lại trên S3 để giảm thời gian upload.</p></div>
              <div className="settings-grid">
                <label><span>Thư mục footage</span><input value={mediaOptions.videoDir} onChange={(event) => setMediaOptions({...mediaOptions, videoDir: event.target.value})} /></label>
                <label><span>Thư mục ảnh tĩnh</span><input value={mediaOptions.imageDir} onChange={(event) => setMediaOptions({...mediaOptions, imageDir: event.target.value})} /></label>
                <label><span>Số video nguồn</span><input type="number" min="10" max="15" value={mediaOptions.videoCount} onChange={(event) => setMediaOptions({...mediaOptions, videoCount: Number(event.target.value)})} /></label>
                <label><span>Random seed</span><input value={mediaOptions.seed} onChange={(event) => setMediaOptions({...mediaOptions, seed: event.target.value})} /></label>
                <label><span>Video mỗi chu kỳ</span><input type="number" min="0" max="10" value={mediaOptions.videosPerCycle} onChange={(event) => setMediaOptions({...mediaOptions, videosPerCycle: Number(event.target.value)})} /></label>
                <label><span>Ảnh mỗi chu kỳ</span><input type="number" min="0" max="10" value={mediaOptions.imagesPerCycle} onChange={(event) => setMediaOptions({...mediaOptions, imagesPerCycle: Number(event.target.value)})} /></label>
                <label><span>Intro (giây)</span><input type="number" min="0" max="30" value={mediaOptions.introSeconds} onChange={(event) => setMediaOptions({...mediaOptions, introSeconds: Number(event.target.value)})} /></label>
                <label><span>File nhạc nền</span><input value={mediaOptions.musicPath} onChange={(event) => setMediaOptions({...mediaOptions, musicPath: event.target.value})} placeholder="Để trống = tắt nhạc nền" /></label>
                <label><span>Âm lượng nhạc intro (tắt khi voiceover)</span><input type="number" min="0" max="1" step="0.05" value={mediaOptions.musicIntroVolume} onChange={(event) => setMediaOptions({...mediaOptions, musicIntroVolume: Number(event.target.value)})} /></label>
              </div>
              <div className="parallel-render-bar"><div><strong>{renderableLanguages.length} ngôn ngữ đã có MP3/SRT</strong><span>{status?.lambdaConfigured ? 'Sẵn sàng render song song' : 'Thêm cấu hình AWS/Remotion Lambda trong .env để render'}</span></div><button className="primary" disabled={!status?.lambdaConfigured || renderableLanguages.length === 0 || busy.lambda} onClick={() => renderLanguages(renderableLanguages)}>{busy.lambda ? 'Lambda đang render…' : `Render song song ${renderableLanguages.length || ''} video`}</button></div>
            </section>
          </>
        )}
      </main>
      <footer><span>Prayer Studio</span><span>OpenAI, Kie, DeepSeek và AWS credentials chỉ tồn tại ở backend</span></footer>
    </div>
  );
};
