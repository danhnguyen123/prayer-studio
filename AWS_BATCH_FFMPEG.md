# AWS Batch FFmpeg — tối đa 5 EC2 Spot worker

Branch này chỉ dùng FFmpeg trên AWS Batch để render video. Compute environment có
`maxvCpus: 20`, mỗi job yêu cầu 4 vCPU, do đó có
tối đa **năm** EC2 Spot worker ARM chạy tại một thời điểm. Năm ngôn ngữ được submit
song song; nếu sau này có nhiều hơn năm, backend giữ giới hạn đồng thời ở năm job.

## 1. Điều kiện

- AWS CLI và Docker đã cài trên Oracle VM.
- AWS credentials trên VM có quyền CloudFormation, IAM, Batch, EC2, ECR, S3 và Logs.
- Chọn VPC và ít nhất một subnet có đường ra Internet. Nếu là public subnet, bật
  auto-assign public IPv4; nếu là private subnet, cần NAT Gateway hoặc VPC endpoints
  cho ECR, S3 và CloudWatch Logs.

## 2. Tạo hạ tầng và push worker

```bash
cd /opt/prayer-studio
git fetch origin
git switch codex/aws-batch-ffmpeg
git pull --ff-only

export AWS_REGION=ap-southeast-1
export VPC_ID=vpc-xxxxxxxx
export SUBNET_IDS=subnet-xxxxxxxx,subnet-yyyyyyyy
chmod +x scripts/deploy-batch-worker.sh
./scripts/deploy-batch-worker.sh
```

Script tạo:

- S3 bucket private, lifecycle xóa plan/status tạm trong `batch-jobs/` sau 2 ngày;
- video cuối trong `batch-renders/` được giữ lại cho đến khi bạn chủ động xóa;
- ECR repository giữ tối đa 5 worker image;
- AWS Batch Spot compute environment ARM;
- giới hạn 20 vCPU = tối đa năm `c7g.xlarge` hoặc `c6g.xlarge`, mỗi máy 4 vCPU/8 GB;
- job queue, job definition, IAM least-privilege và CloudWatch log group;
- build/push `Dockerfile.batch` lên ECR.

Cuối script sẽ in bốn biến `AWS_BATCH_*`. Chép chúng vào `.env` trên Oracle rồi:

```bash
docker compose up -d --force-recreate
curl -u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASS" http://127.0.0.1:4300/api/status
```

`batchConfigured` phải là `true`.

## 3. Quyền của backend Oracle

AWS key mà web backend dùng cần các action:

```text
batch:SubmitJob
batch:DescribeJobs
batch:CancelJob
batch:TerminateJob
batch:TagResource
s3:GetObject
s3:PutObject
s3:AbortMultipartUpload
```

Giới hạn S3 resource vào bucket stack vừa tạo; giới hạn Batch resource vào queue và
job definition. Worker không nhận key từ Oracle: nó dùng `WorkerJobRole` của ECS.

## 4. Render

1. Upload MP3 + SRT cho từng ngôn ngữ.
2. Bấm `Render FFmpeg · 1 worker`.
3. Backend tạo media plan, cache footage/ảnh/audio trên S3 và submit tối đa 5 Batch job song song.
4. EC2 Spot tải đúng media cần dùng, encode H.264/AAC, burn ASS subtitles, xóa
   metadata và upload MP4 cuối lên S3.
5. UI trả signed URL 7 ngày.

Các nút **Dừng render** và **Dừng tất cả & giải phóng EC2** hủy job
trong queue hoặc terminate job đang chạy. Khi không còn job, compute environment có
`MinvCpus: 0` sẽ tự scale về 0; không terminate EC2 thủ công.

Giá trị mặc định:

```dotenv
AWS_BATCH_TIMEOUT_SECONDS=7200
AWS_BATCH_RETRY_ATTEMPTS=2
FFMPEG_CRF=20
FFMPEG_PRESET=veryfast
```

## 5. Chẩn đoán

```bash
aws batch list-jobs --region ap-southeast-1 --job-queue "$AWS_BATCH_JOB_QUEUE" --job-status RUNNING
aws logs tail /aws/batch/prayer-studio-ffmpeg --region ap-southeast-1 --follow
```

Nếu job đứng ở `RUNNABLE`, thường là thiếu Spot capacity, subnet không ra Internet,
EC2 Spot quota dưới 20 vCPU hoặc instance role chưa đúng. Template cho phép cả c7g
và c6g để tăng khả năng có capacity. Để đủ cả 5 worker đồng thời, yêu cầu quota
`All Standard Spot Instance Requests` ít nhất 20 vCPU tại region Singapore.
