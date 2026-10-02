import { useEffect, useMemo, useState } from "react";
import { api, type Job, type LanguageJobState, waitForJob } from "./api";

type Language = { code: string; label: string; config: string };
type Status = {
  ok: boolean;
  translationConfigured: boolean;
  translationProvider: string;
  translationModel: string;
  translationReasoningEffort: string;
  defaultTranslationProvider: "openai" | "kie";
  providers: Record<"openai" | "kie", { configured: boolean; label: string }>;
  batchSupported: boolean;
  batchConfigured: boolean;
  batchRegion: string;
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
type LocalFiles = { audio?: File; srt?: File };

const stageLabels: Record<string, string> = {
  queued: "Đang chờ",
  translating: "GPT Terra đang dịch",
  generating: "Đang rewrite",
  "script-ready": "Kịch bản sẵn sàng",
  planning: "Đang tạo timeline",
  "uploading-media": "Đang tải media lên S3",
  "starting-batch": "Đang khởi chạy Batch",
  "batch-queued": "Đang chờ EC2 Spot",
  "downloading-result": "Đang lưu vào media volume",
  rendering: "FFmpeg đang render",
  stopping: "Đang dừng",
  cancelled: "Đã dừng",
  completed: "Video sẵn sàng",
  failed: "Có lỗi",
};

const activeRenderStages = new Set([
  "queued",
  "planning",
  "uploading-media",
  "starting-batch",
  "batch-queued",
  "rendering",
  "stopping",
]);

// Seed ngẫu nhiên để thứ tự video/ảnh khác nhau mỗi lần render.
const randomSeed = () => Math.random().toString(36).slice(2, 10);

const formatBytes = (bytes = 0) => {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
};

const formatElapsedTime = (
  startedAt?: string,
  finishedAt?: string,
  now = Date.now(),
) => {
  if (!startedAt) return "";
  const start = Date.parse(startedAt);
  const finish = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return "";
  const totalSeconds = Math.max(0, Math.floor((finish - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const StepLabel = ({
  number,
  children,
}: {
  number: string;
  children: React.ReactNode;
}) => (
  <div className="step-label">
    <span>{number}</span>
    <h2>{children}</h2>
  </div>
);

type PageName = "write" | "upload" | "renders";
const pageFromPath = (): PageName => {
  const value = window.location.pathname.replace(/^\//, "").split("/")[0];
  return value === "upload" || value === "renders" ? value : "write";
};

export const App = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [koreanScript, setKoreanScript] = useState("");
  const [selectedLanguages, setSelectedLanguages] = useState([
    "france",
    "poland",
    "germany",
    "italia",
    "korea",
  ]);
  const [rewriteModes, setRewriteModes] = useState<Record<string, string>>({
    france: "gpt-korea",
    poland: "gpt-korea",
    germany: "gpt-korea",
    italia: "gpt-korea",
    korea: "gpt-korea",
  });
  const [translationProvider, setTranslationProvider] = useState<
    "openai" | "kie"
  >("openai");
  const [processingMode, setProcessingMode] = useState<"standard" | "batch">(
    "standard",
  );
  const [workflow, setWorkflow] = useState<Job | null>(null);
  const [uploadWorkflow, setUploadWorkflow] = useState<Job | null>(null);
  const [renderJob, setRenderJob] = useState<Job | null>(null);
  const [renderJobs, setRenderJobs] = useState<Job[]>([]);
  const [activePage, setActivePage] = useState<PageName>(pageFromPath);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("prayer-sidebar-collapsed") === "true",
  );
  const [files, setFiles] = useState<Record<string, LocalFiles>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [mediaOptions, setMediaOptions] = useState({
    videoDir: "",
    imageDir: "",
    videoCount: 12,
    seed: randomSeed(),
    introSeconds: 8,
    musicPath: "",
    musicVolume: 0,
    musicIntroVolume: 0.2,
    videosPerCycle: 10,
    imagesPerCycle: 5,
  });
  const [introTexts, setIntroTexts] = useState<Record<string, string>>({});
  const [clockNow, setClockNow] = useState(() => Date.now());

  const hasActiveRenderTimer = renderJobs.some((job) =>
    Object.values(job.languages || {}).some(
      (language) => language.renderStartedAt && !language.renderFinishedAt,
    ),
  );

  useEffect(() => {
    if (!hasActiveRenderTimer) return undefined;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveRenderTimer]);

  useEffect(() => {
    api<Status>("/api/status")
      .then((nextStatus) => {
        setStatus(nextStatus);
        setMediaOptions((current) => ({
          ...current,
          videoDir: nextStatus.defaults.videoDir,
          imageDir: nextStatus.defaults.imageDir,
          musicPath: nextStatus.defaults.musicPath ?? current.musicPath,
          introSeconds:
            nextStatus.defaults.introSeconds ?? current.introSeconds,
          musicVolume: nextStatus.defaults.musicVolume ?? current.musicVolume,
          musicIntroVolume:
            nextStatus.defaults.musicIntroVolume ?? current.musicIntroVolume,
        }));
      })
      .catch((nextError) => setError(nextError.message));
  }, []);

  useEffect(() => {
    const restore = async () => {
      try {
        const [savedWorkflow, savedUploadWorkflow, savedRenders] = await Promise.all([
          api<Job | null>("/api/workflows/current?kind=script"),
          api<Job | null>("/api/workflows/current?kind=upload"),
          api<Job[]>("/api/render-jobs"),
        ]);
        if (savedWorkflow) setWorkflow(savedWorkflow);
        if (savedUploadWorkflow) setUploadWorkflow(savedUploadWorkflow);
        setRenderJobs(savedRenders);
        setRenderJob(savedRenders[0] || null);
      } catch (nextError) {
        setError((nextError as Error).message);
      } finally {
        setRestoreComplete(true);
      }
    };
    void restore();
    const onPopState = () => setActivePage(pageFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const refresh = async () => {
      try {
        const next = await api<Job[]>("/api/render-jobs");
        setRenderJobs(next);
        setRenderJob(next[0] || null);
      } catch {
        // Giữ UI hiện tại khi mất mạng tạm thời.
      }
    };
    const timer = window.setInterval(
      refresh,
      activePage === "renders" ? 2000 : 8000,
    );
    return () => window.clearInterval(timer);
  }, [activePage]);

  const navigate = (page: PageName) => {
    window.history.pushState({}, "", `/${page}`);
    setActivePage(page);
  };

  const toggleSidebar = () =>
    setSidebarCollapsed((current) => {
      window.localStorage.setItem("prayer-sidebar-collapsed", String(!current));
      return !current;
    });

  const workflowLanguages = useMemo(
    () =>
      (activePage === "upload" ? uploadWorkflow : workflow)?.selectedLanguages ||
      selectedLanguages,
    [activePage, uploadWorkflow, workflow, selectedLanguages],
  );
  const setActionBusy = (key: string, value: boolean) =>
    setBusy((current) => ({ ...current, [key]: value }));
  const toggleLanguage = (code: string) =>
    setSelectedLanguages((current) =>
      current.includes(code)
        ? current.filter((item) => item !== code)
        : [...current, code],
    );

  const startWorkflow = async () => {
    setError("");
    setRenderJob(null);
    setFiles({});
    setActionBusy("workflow", true);
    try {
      const { jobId } = await api<{ jobId: string }>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          koreanScript,
          languages: selectedLanguages,
          rewriteModes,
          translationProvider,
          processingMode,
        }),
      });
      await waitForJob(jobId, setWorkflow);
      window.localStorage.setItem("prayer-workflow-id", jobId);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setActionBusy("workflow", false);
    }
  };

  const createUploadWorkflow = async () => {
    setError("");
    setRenderJob(null);
    setFiles({});
    setActionBusy("upload-workflow", true);
    try {
      const { jobId } = await api<{ jobId: string }>(
        "/api/workflows/skip-script",
        {
          method: "POST",
          body: JSON.stringify({ languages: selectedLanguages }),
        },
      );
      const nextWorkflow = await api<Job>(`/api/jobs/${jobId}`);
      setUploadWorkflow(nextWorkflow);
      window.localStorage.setItem("prayer-workflow-id", jobId);
      return nextWorkflow;
    } catch (nextError) {
      setError((nextError as Error).message);
      return null;
    } finally {
      setActionBusy("upload-workflow", false);
    }
  };

  const openPage = (page: PageName) => {
    navigate(page);
    if (page === "upload" && restoreComplete && !uploadWorkflow) {
      void createUploadWorkflow();
    }
  };

  useEffect(() => {
    if (
      restoreComplete &&
      activePage === "upload" &&
      !uploadWorkflow &&
      !busy["upload-workflow"]
    ) {
      void createUploadWorkflow();
    }
  }, [activePage, restoreComplete, uploadWorkflow]);

  const uploadAssets = async (code: string) => {
    const pair = files[code];
    if (!uploadWorkflow || !pair?.audio || !pair.srt) return;
    setError("");
    setActionBusy(`upload-${code}`, true);
    try {
      const data = new FormData();
      data.append("audio", pair.audio);
      data.append("srt", pair.srt);
      await api(`/api/workflows/${uploadWorkflow.id}/${code}/assets`, {
        method: "POST",
        body: data,
      });
      setUploadWorkflow(await api<Job>(`/api/jobs/${uploadWorkflow.id}`));
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setActionBusy(`upload-${code}`, false);
    }
  };

  const renderLanguages = async (languages: string[]) => {
    if (!uploadWorkflow || languages.length === 0) return;
    setError("");
    setActionBusy("render", true);
    try {
      const { jobId } = await api<{ jobId: string }>("/api/batch/render", {
        method: "POST",
        body: JSON.stringify({
          workflowId: uploadWorkflow.id,
          languages,
          ...mediaOptions,
          introTexts,
        }),
      });
      const submitted = await api<Job>(`/api/jobs/${jobId}`);
      setRenderJob(submitted);
      setRenderJobs((current) => [
        submitted,
        ...current.filter((item) => item.id !== submitted.id),
      ]);
      navigate("renders");
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setActionBusy("render", false);
    }
  };

  const stopRenderLanguage = async (job: Job, code: string) => {
    setError("");
    setActionBusy(`stop-${job.id}-${code}`, true);
    try {
      const updated = await api<Job>(
        `/api/batch/render/${job.id}/${code}/stop`,
        { method: "POST" },
      );
      setRenderJobs((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setActionBusy(`stop-${job.id}-${code}`, false);
    }
  };

  const stopAllRenders = async (job: Job) => {
    setError("");
    setActionBusy(`stop-all-${job.id}`, true);
    try {
      const updated = await api<Job>(`/api/batch/render/${job.id}/stop`, {
        method: "POST",
      });
      setRenderJobs((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setActionBusy(`stop-all-${job.id}`, false);
    }
  };

  const renderableLanguages = workflowLanguages.filter(
    (code) => uploadWorkflow?.languages?.[code]?.assets,
  );
  const workflowActive = workflow && workflow.status !== "completed";

  const renderLanguageCard = (code: string) => {
    const definition = status?.languages.find((item) => item.code === code);
    const currentWorkflow = activePage === "upload" ? uploadWorkflow : workflow;
    const lane = currentWorkflow?.languages?.[code] as LanguageJobState | undefined;
    const pair = files[code] || {};
    const scriptReady = lane?.stage === "script-ready";
    const assetsReady = Boolean(lane?.assets);
    return (
      <article className="language-card" key={code}>
        <div className="language-card-head">
          <div>
            <span
              className={`stage-dot ${lane?.stage === "failed" ? "failed" : scriptReady ? "done" : "working"}`}
            />
            <strong>{definition?.label || lane?.label || code}</strong>
          </div>
          <span className={`stage-badge ${lane?.stage || "queued"}`}>
            {stageLabels[lane?.stage || "queued"] || lane?.message}
          </span>
        </div>
        {activePage === "write" && (
          <>
            <div className="lane-progress">
              <span style={{ width: `${(lane?.progress || 0) * 100}%` }} />
            </div>
            <p className="lane-message">{lane?.message}</p>
            {scriptReady && (
              <div className="script-ready-line">
                <span>✓ Kịch bản đã sẵn sàng</span>
                {lane?.scriptDownloadUrl && (
                  <a href={lane.scriptDownloadUrl} download>
                    Download TXT
                  </a>
                )}
                {!lane?.skippedScript && lane?.outputPath && (
                  <a
                    href={`/api/workflows/${currentWorkflow?.id}/${code}/voiceover`}
                    download
                  >
                    Voiceover chia phần
                  </a>
                )}
              </div>
            )}
          </>
        )}
        {activePage === "upload" && scriptReady && (
          <div className="production-zone">
            <div className="production-inputs">
              <div className="upload-grid">
                <label>
                  <span>Voiceover MP3</span>
                  <input
                    type="file"
                    accept="audio/mpeg,.mp3"
                    onChange={(event) =>
                      setFiles((current) => ({
                        ...current,
                        [code]: {
                          ...current[code],
                          audio: event.target.files?.[0],
                        },
                      }))
                    }
                  />
                  <small>
                    {pair.audio?.name ||
                      lane?.assets?.audioName ||
                      "Chưa chọn file"}
                  </small>
                </label>
                <label>
                  <span>Phụ đề SRT</span>
                  <input
                    type="file"
                    accept=".srt,application/x-subrip"
                    onChange={(event) =>
                      setFiles((current) => ({
                        ...current,
                        [code]: {
                          ...current[code],
                          srt: event.target.files?.[0],
                        },
                      }))
                    }
                  />
                  <small>
                    {pair.srt?.name ||
                      lane?.assets?.srtName ||
                      "Chưa chọn file"}
                  </small>
                </label>
              </div>
              <label className="verse-inline">
                <span>Câu Kinh Thánh intro</span>
                <textarea
                  value={introTexts[code] || ""}
                  onChange={(event) =>
                    setIntroTexts((current) => ({
                      ...current,
                      [code]: event.target.value,
                    }))
                  }
                  rows={3}
                />
              </label>
            </div>
            <div className="card-actions">
              <button
                className="secondary"
                disabled={busy[`upload-${code}`] || !pair.audio || !pair.srt}
                onClick={() => uploadAssets(code)}
              >
                {busy[`upload-${code}`]
                  ? "Đang upload…"
                  : assetsReady
                    ? "Upload lại MP3 + SRT"
                    : "Upload MP3 + SRT"}
              </button>
              <button
                className="primary"
                disabled={
                  !assetsReady || !status?.batchConfigured || busy.render
                }
                onClick={() => renderLanguages([code])}
              >
                Submit render
              </button>
            </div>
          </div>
        )}
      </article>
    );
  };

  return (
    <div
      className={`app-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <span />
            <span />
          </div>
          {!sidebarCollapsed && (
            <div>
              <strong>Prayer Studio</strong>
              <small>FFmpeg workspace</small>
            </div>
          )}
        </div>
        <nav>
          {(
            [
              ["write", "01", "Write Script"],
              ["upload", "02", "Upload & Submit"],
              ["renders", "03", "Render Queue"],
            ] as const
          ).map(([page, number, label]) => (
            <button
              key={page}
              className={activePage === page ? "active" : ""}
              onClick={() => openPage(page)}
            >
              <b>{number}</b>
              {!sidebarCollapsed && <span>{label}</span>}
            </button>
          ))}
        </nav>
        <button className="sidebar-toggle" onClick={toggleSidebar}>
          {sidebarCollapsed ? "»" : "« Thu gọn"}
        </button>
      </aside>
      <div className="app-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">PRODUCTION WORKSPACE</p>
            <h1>
              {activePage === "write"
                ? "Write Script"
                : activePage === "upload"
                  ? "Upload & Submit"
                  : "Render Queue"}
            </h1>
          </div>
          <div className="status-stack">
            <div
              className={`status-pill ${status?.batchConfigured ? "ready" : "warning"}`}
            >
              <span /> AWS Batch{" "}
              {status?.batchConfigured ? "sẵn sàng" : "chưa cấu hình"}
            </div>
            <div className="model-name">
              {status?.translationModel || "Đang kiểm tra…"} ·{" "}
              {status?.batchRegion}
            </div>
          </div>
        </header>
        {error && (
          <div className="alert">
            <strong>Cần xử lý:</strong> {error}
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
        <main>
          {activePage === "write" && (
            <>
              {!workflow ? (
                <section className="panel source-panel">
                  <StepLabel number="01">Kịch bản tiếng Hàn</StepLabel>
                  <div className="language-row">
                    {status?.languages.map((language) => (
                      <label
                        key={language.code}
                        className={`language-chip ${selectedLanguages.includes(language.code) ? "active" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedLanguages.includes(language.code)}
                          onChange={() => toggleLanguage(language.code)}
                        />
                        {language.label}
                      </label>
                    ))}
                  </div>
                  <div className="api-controls">
                    <label>
                      <span>GPT provider</span>
                      <select
                        className="mode-select"
                        value={translationProvider}
                        onChange={(event) =>
                          setTranslationProvider(
                            event.target.value as "openai" | "kie",
                          )
                        }
                      >
                        <option value="openai">OpenAI</option>
                        <option value="kie">Kie</option>
                      </select>
                    </label>
                    <label>
                      <span>Processing</span>
                      <select
                        className="mode-select"
                        value={processingMode}
                        onChange={(event) =>
                          setProcessingMode(
                            event.target.value as "standard" | "batch",
                          )
                        }
                      >
                        <option value="standard">Standard</option>
                        <option value="batch">Batch</option>
                      </select>
                    </label>
                  </div>
                  <div className="rewrite-choice-list">
                    {status?.languages
                      .filter((language) =>
                        selectedLanguages.includes(language.code),
                      )
                      .map((language) => (
                        <div className="rewrite-choice-row" key={language.code}>
                          <strong>{language.label}</strong>
                          <select
                            className="mode-select"
                            value={rewriteModes[language.code]}
                            onChange={(event) =>
                              setRewriteModes((current) => ({
                                ...current,
                                [language.code]: event.target.value,
                              }))
                            }
                          >
                            <option value="translation">Dùng bản dịch</option>
                            <option value="deepseek">DeepSeek v4 Pro</option>
                            <option value="gpt">GPT Terra từ bản dịch</option>
                            <option value="gpt-korea">
                              GPT Terra từ tiếng Hàn
                            </option>
                          </select>
                        </div>
                      ))}
                  </div>
                  <textarea
                    value={koreanScript}
                    onChange={(event) => setKoreanScript(event.target.value)}
                    placeholder="여기에 한국어 기도문을 붙여넣으세요…"
                  />
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={
                        busy.workflow || koreanScript.trim().length < 20
                      }
                      onClick={startWorkflow}
                    >
                      Dịch & tạo kịch bản
                    </button>
                  </div>
                </section>
              ) : (
                <section className="panel workflow-panel">
                  <div className="workflow-heading">
                    <StepLabel number="01">Tiến độ kịch bản</StepLabel>
                    <div className="workflow-actions">
                      <strong>{Math.round(workflow.progress * 100)}%</strong>
                      <button
                        className="ghost"
                        disabled={Boolean(workflowActive)}
                        onClick={() => setWorkflow(null)}
                      >
                        Workflow mới
                      </button>
                    </div>
                  </div>
                  <div className="language-workflows">
                    {workflowLanguages.map(renderLanguageCard)}
                  </div>
                </section>
              )}
            </>
          )}
          {activePage === "upload" && (
            <>
              {!uploadWorkflow ? (
                <section className="panel empty-state">
                  <h2>Đang chuẩn bị khu vực upload…</h2>
                  <p>Bạn có thể upload MP3/SRT mà không cần chạy Write Script.</p>
                </section>
              ) : (
                <>
                  <section className="panel workflow-panel">
                    <StepLabel number="02">MP3, SRT & Submit</StepLabel>
                    <div className="language-workflows">
                      {workflowLanguages.map(renderLanguageCard)}
                    </div>
                  </section>
                  <section className="panel render-settings">
                    <StepLabel number="02">Nguồn hình & FFmpeg</StepLabel>
                    <div className="settings-grid">
                      <label>
                        <span>Footage</span>
                        <input
                          value={mediaOptions.videoDir}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              videoDir: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Ảnh tĩnh</span>
                        <input
                          value={mediaOptions.imageDir}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              imageDir: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Video nguồn</span>
                        <input
                          type="number"
                          value={mediaOptions.videoCount}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              videoCount: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Random seed</span>
                        <div className="seed-field">
                          <input
                            value={mediaOptions.seed}
                            onChange={(event) =>
                              setMediaOptions({
                                ...mediaOptions,
                                seed: event.target.value,
                              })
                            }
                          />
                          <button
                            className="seed-dice"
                            onClick={() =>
                              setMediaOptions({
                                ...mediaOptions,
                                seed: randomSeed(),
                              })
                            }
                          >
                            🎲
                          </button>
                        </div>
                      </label>
                      <label>
                        <span>Video/chu kỳ</span>
                        <input
                          type="number"
                          value={mediaOptions.videosPerCycle}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              videosPerCycle: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Ảnh/chu kỳ</span>
                        <input
                          type="number"
                          value={mediaOptions.imagesPerCycle}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              imagesPerCycle: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Intro (giây)</span>
                        <input
                          type="number"
                          value={mediaOptions.introSeconds}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              introSeconds: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Nhạc intro</span>
                        <input
                          value={mediaOptions.musicPath}
                          onChange={(event) =>
                            setMediaOptions({
                              ...mediaOptions,
                              musicPath: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="parallel-render-bar">
                      <div>
                        <strong>
                          {renderableLanguages.length} ngôn ngữ sẵn sàng
                        </strong>
                        <span>Submit tối đa 5 worker đồng thời</span>
                      </div>
                      <button
                        className="primary"
                        disabled={!renderableLanguages.length || busy.render}
                        onClick={() => renderLanguages(renderableLanguages)}
                      >
                        Submit render tất cả
                      </button>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
          {activePage === "renders" && (
            <section className="panel workflow-panel">
              <div className="workflow-heading">
                <div>
                  <StepLabel number="03">Video đang render</StepLabel>
                  <p className="section-copy">
                    Trạng thái được giữ trên server khi đóng browser.
                  </p>
                </div>
              </div>
              {renderJobs.length === 0 ? (
                <div className="empty-state">
                  <p>Chưa có video nào.</p>
                  <button
                    className="primary"
                    onClick={() => navigate("upload")}
                  >
                    Upload & Submit
                  </button>
                </div>
              ) : (
                <div className="render-job-list">
                  {renderJobs.map((job) => (
                    <section className="render-job-group" key={job.id}>
                      <div className="render-job-heading">
                        <div>
                          <strong>
                            {new Date(
                              job.createdAt || Date.now(),
                            ).toLocaleString("vi-VN")}
                          </strong>
                          <small>{job.message}</small>
                        </div>
                        {Object.values(job.languages || {}).some((lane) =>
                          activeRenderStages.has(lane.stage),
                        ) && (
                          <button
                            className="danger compact"
                            disabled={busy[`stop-all-${job.id}`]}
                            onClick={() => stopAllRenders(job)}
                          >
                            Dừng tất cả
                          </button>
                        )}
                      </div>
                      {Object.entries(job.languages || {}).map(
                        ([code, lane]) => (
                          <article
                            className={`render-queue-item ${lane.stage}`}
                            key={code}
                          >
                            <div>
                              <strong>
                                {status?.languages.find(
                                  (item) => item.code === code,
                                )?.label || code}
                              </strong>
                              <span>
                                {stageLabels[lane.stage] || lane.message} ·{" "}
                                {Math.round(lane.progress * 100)}%
                              </span>
                              {lane.renderStartedAt && (
                                <span className="render-timer">
                                  ⏱{" "}
                                  {formatElapsedTime(
                                    lane.renderStartedAt,
                                    lane.renderFinishedAt,
                                    clockNow,
                                  )}
                                </span>
                              )}
                            </div>
                            <div className="render-status-actions">
                              {lane.downloadUrl && (
                                <a href={lane.downloadUrl} download>
                                  Download {formatBytes(lane.outputSizeInBytes)}
                                </a>
                              )}
                              {activeRenderStages.has(lane.stage) && (
                                <button
                                  className="danger compact"
                                  disabled={busy[`stop-${job.id}-${code}`]}
                                  onClick={() => stopRenderLanguage(job, code)}
                                >
                                  Dừng render
                                </button>
                              )}
                            </div>
                          </article>
                        ),
                      )}
                    </section>
                  ))}
                </div>
              )}
            </section>
          )}
        </main>
        <footer>
          <span>Prayer Studio</span>
          <span>State & media lưu trên mounted volume</span>
        </footer>
      </div>
    </div>
  );
};
