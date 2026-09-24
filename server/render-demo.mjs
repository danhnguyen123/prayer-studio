const response = await fetch('http://127.0.0.1:4300/api/render', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({previewSeconds: 45, seed: 'italia-demo-2026-06-21'}),
});

if (!response.ok) throw new Error(await response.text());
const {jobId} = await response.json();
console.log(`Render job: ${jobId}`);

while (true) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const job = await fetch(`http://127.0.0.1:4300/api/jobs/${jobId}`).then((item) =>
    item.json(),
  );
  console.log(`${Math.round(job.progress * 100)}% ${job.message}`);
  if (job.status === 'completed') {
    console.log(job.result.outputLocation);
    break;
  }
  if (job.status === 'failed') throw new Error(job.error);
}
