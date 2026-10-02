# Prayer Studio

Ứng dụng gồm React/Vite frontend, Express backend, engine viết kịch bản Python và
AWS Batch FFmpeg renderer. Không cần Chrome hoặc framework render video phía web.

## Luồng sử dụng

1. Dán kịch bản tiếng Hàn và chọn ngôn ngữ.
2. Dịch/rewrite bằng provider đã cấu hình, hoặc bỏ qua để dùng MP3/SRT cũ.
3. Upload MP3, SRT và nhập câu Kinh Thánh intro cho từng ngôn ngữ.
4. Chọn thư mục footage, ảnh, nhạc và cấu hình chu kỳ media.
5. Backend cache media lên S3 và submit tối đa 5 AWS Batch job đồng thời.
6. Mỗi ARM Spot worker dùng FFmpeg để dựng H.264/AAC, burn ASS subtitle, làm sạch
   metadata và upload MP4 hoàn tất lên S3.

## Chạy local

```bash
npm ci
npm run dev
```

Mặc định web chạy tại `http://127.0.0.1:4300`.

## Kiểm tra

```bash
npm run typecheck
npm test
npm run build
```

## AWS Batch

Xem [AWS_BATCH_FFMPEG.md](AWS_BATCH_FFMPEG.md) để tạo S3, ECR, IAM, compute
environment, job queue và job definition. AWS credentials phải nằm trong `.env`
trên backend và không được commit.
