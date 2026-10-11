import { useEffect, useState } from "react";
import { api, type VoiceEntry, type VoiceSettings } from "./api";

type Language = { code: string; label: string };

const sampleTexts: Record<string, string> = {
  france:
    "Seigneur, merci pour cette nouvelle journée. Garde mon cœur dans ta paix.",
  poland:
    "Panie, dziękuję Ci za ten nowy dzień. Zachowaj moje serce w Twoim pokoju.",
  germany:
    "Herr, danke für diesen neuen Tag. Bewahre mein Herz in deinem Frieden.",
  italia:
    "Signore, grazie per questo nuovo giorno. Custodisci il mio cuore nella tua pace.",
  korea:
    "주님, 오늘 새로운 하루를 주셔서 감사합니다. 제 마음을 주님의 평화 안에 지켜 주소서.",
};

const formatDate = (value?: string) =>
  value ? new Date(value).toLocaleString("vi-VN") : "";

const SPEED_MIN = 0.5;
const SPEED_MAX = 1.5;
const SPEED_STEP = 0.01;
const clampSpeed = (value: number) =>
  Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value * 100) / 100));

const SpeedStepper = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) => (
  <div className="speed-stepper">
    <button
      type="button"
      aria-label="Giảm speed 0.01"
      disabled={value <= SPEED_MIN}
      onClick={() => onChange(clampSpeed(value - SPEED_STEP))}
    >
      −
    </button>
    <input
      type="number"
      min={SPEED_MIN}
      max={SPEED_MAX}
      step={SPEED_STEP}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      onBlur={() => onChange(clampSpeed(value || 1))}
    />
    <button
      type="button"
      aria-label="Tăng speed 0.01"
      disabled={value >= SPEED_MAX}
      onClick={() => onChange(clampSpeed(value + SPEED_STEP))}
    >
      +
    </button>
  </div>
);

const VoiceRow = ({
  code,
  voice,
  isDefault,
  onChanged,
  onError,
}: {
  code: string;
  voice: VoiceEntry;
  isDefault: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) => {
  const [draft, setDraft] = useState({
    voiceId: voice.voiceId,
    speed: voice.speed,
  });
  const [sampleText, setSampleText] = useState(
    voice.sample?.text || sampleTexts[code] || "",
  );
  const [busy, setBusy] = useState("");

  useEffect(() => {
    setDraft({ voiceId: voice.voiceId, speed: voice.speed });
  }, [voice.voiceId, voice.speed]);

  const dirty =
    draft.voiceId.trim() !== voice.voiceId ||
    Number(draft.speed) !== voice.speed;
  const sampleStale =
    voice.sample &&
    (voice.sample.voiceId !== voice.voiceId ||
      voice.sample.speed !== voice.speed);
  const base = `/api/voices/${code}/${voice.key}`;

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await onChanged();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <article className={`voice-row ${isDefault ? "default" : ""}`}>
      <div className="voice-title">
        <strong>{voice.name}</strong>
        {[voice.language, voice.gender].filter(Boolean).map((tag) => (
          <small key={tag}>{tag}</small>
        ))}
      </div>
      <div className="voice-fields">
        <label>
          <span>Voice ID</span>
          <input
            value={draft.voiceId}
            onChange={(event) =>
              setDraft({ ...draft, voiceId: event.target.value })
            }
          />
        </label>
        <label>
          <span>Speed</span>
          <SpeedStepper
            value={draft.speed}
            onChange={(speed) => setDraft({ ...draft, speed })}
          />
        </label>
      </div>
      <div className="card-actions">
        <button
          className={isDefault ? "secondary default-toggle" : "ghost"}
          disabled={isDefault || Boolean(busy)}
          onClick={() =>
            run("default", () => api(`${base}/default`, { method: "POST" }))
          }
        >
          {isDefault ? "★ Mặc định" : "Đặt mặc định"}
        </button>
        <button
          className="secondary"
          disabled={!dirty || Boolean(busy)}
          onClick={() =>
            run("save", () =>
              api(base, { method: "PUT", body: JSON.stringify(draft) }),
            )
          }
        >
          {busy === "save"
            ? draft.voiceId.trim() !== voice.voiceId
              ? "Đang kiểm tra ai33…"
              : "Đang lưu…"
            : "Lưu"}
        </button>
        <button
          className="danger compact"
          disabled={Boolean(busy)}
          onClick={() => {
            if (window.confirm(`Xóa voice "${voice.name}"?`)) {
              void run("delete", () => api(base, { method: "DELETE" }));
            }
          }}
        >
          Xóa
        </button>
      </div>
      <div className="voice-sample">
        <textarea
          value={sampleText}
          rows={2}
          onChange={(event) => setSampleText(event.target.value)}
          placeholder="Nhập text để nghe thử…"
        />
        <div className="voice-sample-actions">
          <button
            className="primary"
            disabled={Boolean(busy) || dirty || !sampleText.trim()}
            title={dirty ? "Lưu thay đổi trước khi nghe thử" : undefined}
            onClick={() =>
              run("sample", () =>
                api(`${base}/sample`, {
                  method: "POST",
                  body: JSON.stringify({ text: sampleText }),
                }),
              )
            }
          >
            {busy === "sample" ? "ai33 đang tạo…" : "Tạo & nghe thử"}
          </button>
          {voice.sample && (
            <>
              <audio
                controls
                preload="none"
                src={`${base}/sample?v=${encodeURIComponent(voice.sample.createdAt)}`}
              />
              <small className={sampleStale ? "error-text" : ""}>
                {sampleStale
                  ? "Sample tạo với voice/speed cũ"
                  : `Speed ${voice.sample.speed} · ${formatDate(voice.sample.createdAt)}`}
              </small>
            </>
          )}
        </div>
      </div>
    </article>
  );
};

export const VoicesPage = ({
  languages,
  settings,
  onChanged,
  onError,
}: {
  languages: Language[];
  settings: VoiceSettings | null;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) => {
  const [activeCode, setActiveCode] = useState(languages[0]?.code || "");
  const [global, setGlobal] = useState({ gapSeconds: 0.3, maxChars: 950 });
  const [newVoice, setNewVoice] = useState({ voiceId: "", speed: 1 });
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!activeCode && languages[0]) setActiveCode(languages[0].code);
  }, [languages, activeCode]);

  useEffect(() => {
    if (settings) {
      setGlobal({
        gapSeconds: settings.gapSeconds,
        maxChars: settings.maxChars,
      });
    }
  }, [settings?.gapSeconds, settings?.maxChars]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await onChanged();
      return true;
    } catch (error) {
      onError((error as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  };

  const language = settings?.languages[activeCode];
  const globalDirty =
    settings &&
    (Number(global.gapSeconds) !== settings.gapSeconds ||
      Number(global.maxChars) !== settings.maxChars);

  return (
    <>
      <section className="panel workflow-panel">
        <div className="workflow-heading">
          <div>
            <div className="step-label">
              <span>04</span>
              <h2>Cài đặt voiceover</h2>
            </div>
            <p className="section-copy">
              Tên voice được lấy tự động từ ai33 khi thêm. Voice ID dùng prefix:{" "}
              <code>elevenlabs_</code>, <code>minimax_</code>,{" "}
              <code>edge_</code>, <code>clone_</code>, <code>kokoro_</code>,{" "}
              <code>vbee_</code>, <code>fishaudio_</code>.
            </p>
          </div>
          <div
            className={`status-pill ${settings?.ai33Configured ? "ready" : "warning"}`}
          >
            <span /> ai33{" "}
            {!settings
              ? "đang kiểm tra…"
              : settings.ai33Configured
                ? settings.credits !== null
                  ? `· ${settings.credits.toLocaleString("vi-VN")} credits`
                  : "sẵn sàng"
                : "thiếu AI33_API_KEY"}
          </div>
        </div>
        <div className="voice-global">
          <label>
            <span>Nghỉ giữa các phần (giây)</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={global.gapSeconds}
              onChange={(event) =>
                setGlobal({ ...global, gapSeconds: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>Ký tự tối đa mỗi phần</span>
            <input
              type="number"
              min={200}
              max={5000}
              step={50}
              value={global.maxChars}
              onChange={(event) =>
                setGlobal({ ...global, maxChars: Number(event.target.value) })
              }
            />
          </label>
          <button
            className="secondary"
            disabled={!globalDirty || Boolean(busy)}
            onClick={() =>
              run("global", () =>
                api("/api/voices/settings", {
                  method: "PUT",
                  body: JSON.stringify(global),
                }),
              )
            }
          >
            Lưu cài đặt
          </button>
        </div>
      </section>
      <section className="panel workflow-panel voice-library">
        <div className="voice-tabs" role="tablist">
          {languages.map((item) => (
            <button
              key={item.code}
              role="tab"
              aria-selected={item.code === activeCode}
              className={item.code === activeCode ? "active" : ""}
              onClick={() => setActiveCode(item.code)}
            >
              {item.label}
              <small>
                {settings?.languages[item.code]?.voices.length || 0}
              </small>
            </button>
          ))}
        </div>
        <div className="voice-list">
          {settings && !language?.voices.length && (
            <p className="lane-message">
              Chưa có voice nào. Thêm voice bên dưới.
            </p>
          )}
          {!settings && <p className="lane-message">Đang tải voice…</p>}
          {language?.voices.map((voice) => (
            <VoiceRow
              key={voice.key}
              code={activeCode}
              voice={voice}
              isDefault={language.defaultVoiceKey === voice.key}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </div>
        <div className="voice-add">
          <label>
            <span>Voice ID</span>
            <input
              value={newVoice.voiceId}
              placeholder="elevenlabs_xxx / edge_fr-FR-HenriNeural"
              onChange={(event) =>
                setNewVoice({ ...newVoice, voiceId: event.target.value })
              }
            />
          </label>
          <label>
            <span>Speed</span>
            <SpeedStepper
              value={newVoice.speed}
              onChange={(speed) => setNewVoice({ ...newVoice, speed })}
            />
          </label>
          <button
            className="primary"
            disabled={!newVoice.voiceId.trim() || Boolean(busy)}
            onClick={async () => {
              const added = await run("add", () =>
                api(`/api/voices/${activeCode}`, {
                  method: "POST",
                  body: JSON.stringify(newVoice),
                }),
              );
              if (added) setNewVoice({ voiceId: "", speed: 1 });
            }}
          >
            {busy === "add" ? "Đang kiểm tra ai33…" : "+ Kiểm tra & thêm"}
          </button>
        </div>
      </section>
    </>
  );
};
