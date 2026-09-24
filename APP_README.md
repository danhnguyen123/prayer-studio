# YoutubePrayGeneration — Prayer Studio

Ứng dụng local gồm React/Vite frontend, Express backend, engine viết kịch bản Python được clone từ `auto-script`, Remotion Player và Remotion Lambda.

## Luồng làm việc

1. Dán kịch bản cầu nguyện tiếng Hàn và chọn France, Poland, Germany, Italy hoặc Korea.
2. Backend mặc định dùng **OpenAI Responses API chính thức với GPT-5.6 Terra medium**. Có thể chọn Standard để nhận kết quả ngay hoặc OpenAI Batch để giảm 50% chi phí; Kie vẫn có thể chọn làm provider dự phòng. Korea dùng trực tiếp nguồn tiếng Hàn và không gọi API dịch. API key không đi xuống frontend.
3. Mỗi bản dịch được lưu vào `samples/translate/<language>_korea/`, sau đó `viral_sample_file` của đúng config được cập nhật.
4. Mỗi ngôn ngữ có ba lựa chọn: dùng thẳng bản dịch (mặc định), rewrite bằng DeepSeek v4 Pro, hoặc rewrite bằng GPT-5.6 Terra medium qua provider đã chọn. UI hiển thị tiến độ riêng và cho tải kịch bản TXT. Khi chọn Batch, bước dịch được gom vào một batch theo `custom_id`; các request GPT rewrite cũng dùng Batch API.
5. Người dùng tạo voiceover/phụ đề bên ngoài rồi upload MP3 + SRT vào đúng hàng ngôn ngữ.
6. Preview chạy trong Remotion Player. Caption nằm giữa khung hình, cỡ lớn và không có nền chữ.
7. Nút render chung gửi tất cả ngôn ngữ đã sẵn sàng lên Remotion Lambda đồng thời. Kết quả private trên S3 được trả về bằng URL ký tạm thời để tải video.

Timeline chọn 10–15 video theo random seed, chèn một ảnh tĩnh 15 giây sau mỗi 2–3 video và lặp nguồn đến hết voiceover. Video xuất H.264/AAC, 1920×1080, 30fps.

## Cài đặt local

Yêu cầu Node.js 20.6+, FFmpeg/FFprobe trên `PATH`, và Python cùng các package trong `requirements.txt`.

```powershell
cd C:\Users\Admin\Documents\Python\YoutubePrayGeneration
Copy-Item .env.example .env
npm install --cache .npm-cache
pip install -r requirements.txt
npm run dev
```

Mở `http://127.0.0.1:4300`.

Thiết lập OpenAI, Kie dự phòng và Python trong `.env`:

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=medium
OPENAI_BATCH_POLL_MS=10000

# Tùy chọn dự phòng
KIE_API_KEY=your_kie_token_here

PYTHON_EXECUTABLE=C:\Path\To\python.exe
```

Bạn cũng có thể để key môi trường trống và đặt token ở dòng đầu của `API_OPENAI.txt` hoặc `API_KIE.txt`. Năm config GPT nằm trong `configs/*_prayer_gpt_terra.yaml`; OpenAI chính thức là provider mặc định. Các config này dùng lại persona của DeepSeek và đặt `length_per_part` bằng `target_length`, vì vậy toàn bộ kịch bản được viết trong một request.

OpenAI Batch là bất đồng bộ: API cam kết hoàn tất trong vòng 24 giờ và thường nhanh hơn. Backend cần tiếp tục chạy để polling, nhận output JSONL và cập nhật từng hàng ngôn ngữ. Standard phù hợp khi cần kết quả ngay; Batch phù hợp khi ưu tiên tiết kiệm chi phí.

Không đặt secret vào biến bắt đầu bằng `VITE_`; Vite sẽ bundle biến đó xuống frontend. `.env`, `API.txt`, `API_DEEPSEEK.txt`, `API_OPENAI.txt` và `API_KIE.txt` đã nằm trong `.gitignore`.

## Remotion Lambda

Làm theo [Remotion Lambda setup](https://www.remotion.dev/docs/lambda/setup) để tạo IAM policy/user và cấu hình AWS CLI. Sau đó deploy function tương thích đúng phiên bản Remotion của dự án:

```powershell
npx remotion lambda policies validate
npx remotion lambda functions deploy --memory=2048 --disk=10240 --timeout=900
npx remotion lambda functions ls --region=ap-southeast-1
```

Chép tên function trả về vào `.env`. Có thể dùng profile AWS tiêu chuẩn hoặc credential riêng cho backend:

```dotenv
REMOTION_AWS_REGION=ap-southeast-1
REMOTION_FUNCTION_NAME=remotion-render-4-0-523-mem2048mb-disk10240mb-900sec
REMOTION_RENDERER_FUNCTION_NAME=remotion-render-4-0-523-mem2048mb-disk10240mb-900sec
REMOTION_CONCURRENCY=200
AWS_PROFILE=your-profile

# Hoặc thay AWS_PROFILE bằng ba biến sau:
REMOTION_AWS_ACCESS_KEY_ID=...
REMOTION_AWS_SECRET_ACCESS_KEY=...
REMOTION_AWS_SESSION_TOKEN=
```

`REMOTION_FUNCTION_NAME` là Lambda chính dùng để điều phối và ghép video cuối.
`REMOTION_RENDERER_FUNCTION_NAME` là Lambda dùng để render các chunk; có thể giữ
function 2.048 MB ở biến này trong khi dùng function nhiều RAM hơn làm function
chính. Hai function phải cùng phiên bản Remotion, region và tài khoản AWS.

Project và Lambda đều dùng Remotion `4.0.523`. Lần render đầu tiên backend tự bundle và deploy Remotion site. Nếu đã có site, đặt `REMOTION_SERVE_URL` để dùng lại. Media nguồn được upload private lên S3; output cũng private và URL download mặc định hết hạn sau 7 ngày.

Lambda có chi phí AWS và giới hạn concurrency. Trước khi chạy nhiều video dài, kiểm tra quota bằng `npx remotion lambda quotas`, đặt AWS Budget/alert, và thử trước với một ngôn ngữ. Ứng dụng chỉ bind `127.0.0.1`; nếu triển khai thành dịch vụ public, cần thêm authentication, rate limiting và cơ chế dọn file upload/S3 theo chính sách lưu trữ của bạn.

## Lệnh hữu ích

```powershell
npm run dev
npm run typecheck
npm test
npm run build
npm run remotion:studio
npm run render:demo
```

## Dữ liệu demo đã xác nhận

- Voiceover: `D:\Project\Italia Prayer\5\Script_1_2026_06_21_19_16_22.mp3`
- Subtitle: `D:\Project\Italia Prayer\5\Script_1_2026_06_21_19_16_22.srt`
- Footage: `D:\Materials\Video 4K`
- Ảnh: `D:\Materials\Pray\Image`

Tên thực tế của MP3/SRT không có thư mục `Script` và không có dấu gạch dưới ở đầu tên. Voiceover demo dài khoảng 36 phút 49 giây.
