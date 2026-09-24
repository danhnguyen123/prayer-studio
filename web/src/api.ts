export const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const isFormData = options?.body instanceof FormData;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(isFormData ? {} : {'Content-Type': 'application/json'}),
      ...options?.headers,
    },
  });
  const raw = await response.text();
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw || response.statusText}`);
    throw new Error('Backend trả về dữ liệu không hợp lệ.');
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload as T;
};

export const waitForJob = async (
  jobId: string,
  onUpdate: (job: Job) => void,
): Promise<Job> => {
  while (true) {
    const job = await api<Job>(`/api/jobs/${jobId}`);
    onUpdate(job);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error || job.message);
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
};

export type Job = {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  error?: string;
  logs: string[];
  selectedLanguages?: string[];
  languages?: Record<string, LanguageJobState>;
  result?: Record<string, any> & {
    outputLocation?: string;
    fileName?: string;
    sizeBytes?: number;
  };
};

export type LanguageJobState = {
  code: string;
  label?: string;
  stage: string;
  progress: number;
  message: string;
  error?: string;
  model?: string;
  translationModel?: string;
  translationProvider?: 'openai' | 'kie' | 'source';
  processingMode?: 'standard' | 'batch';
  skippedScript?: boolean;
  rewriteMode?: 'translation' | 'deepseek' | 'gpt' | 'gpt-korea';
  translationPath?: string;
  outputPath?: string;
  scriptDownloadUrl?: string;
  assets?: {
    audioPath: string;
    audioName: string;
    srtPath: string;
    srtName: string;
  } | null;
  downloadUrl?: string;
  outputSizeInBytes?: number;
  renderId?: string;
};
