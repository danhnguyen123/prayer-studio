import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const jobs = new Map();
const statePath = process.env.JOB_STATE_PATH?.trim();
let saveTimer;

if (statePath) {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const job of Array.isArray(saved) ? saved : []) {
      if (job?.id) jobs.set(job.id, job);
    }
    console.log(`[job state] Khôi phục ${jobs.size} job từ ${statePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[job state] Không đọc được state: ${error.message}`);
  }
}

const persistJobs = () => {
  if (!statePath) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(path.dirname(statePath), {recursive: true});
      const temporary = `${statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify([...jobs.values()], null, 2));
      renameSync(temporary, statePath);
    } catch (error) {
      console.warn(`[job state] Không ghi được state: ${error.message}`);
    }
  }, 100);
  saveTimer.unref();
};

export const createJob = (type, details = {}) => {
  const id = randomUUID();
  const job = {
    id,
    type,
    status: 'queued',
    progress: 0,
    message: 'Đang chờ xử lý',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...details,
  };
  jobs.set(id, job);
  persistJobs();
  return job;
};

export const getJob = (id) => jobs.get(id) ?? null;

export const listJobs = ({type} = {}) => [...jobs.values()]
  .filter((job) => !type || job.type === type)
  .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

export const updateJob = (id, patch) => {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, {updatedAt: new Date().toISOString()});
  persistJobs();
  return job;
};

export const appendJobLog = (id, line) => {
  const job = jobs.get(id);
  if (!job || !line) return;
  job.logs.push(String(line).trimEnd());
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  job.updatedAt = new Date().toISOString();
  persistJobs();
};

export const mutateJob = (id, mutator) => {
  const job = jobs.get(id);
  if (!job) return null;
  mutator(job);
  job.updatedAt = new Date().toISOString();
  persistJobs();
  return job;
};
