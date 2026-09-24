import {randomUUID} from 'node:crypto';

const jobs = new Map();

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
  return job;
};

export const getJob = (id) => jobs.get(id) ?? null;

export const updateJob = (id, patch) => {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, {updatedAt: new Date().toISOString()});
  return job;
};

export const appendJobLog = (id, line) => {
  const job = jobs.get(id);
  if (!job || !line) return;
  job.logs.push(String(line).trimEnd());
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  job.updatedAt = new Date().toISOString();
};

export const mutateJob = (id, mutator) => {
  const job = jobs.get(id);
  if (!job) return null;
  mutator(job);
  job.updatedAt = new Date().toISOString();
  return job;
};
