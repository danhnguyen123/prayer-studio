# Deploy Prayer Studio lên Oracle Ubuntu (ARM) bằng Docker + GitHub Actions

Repo: `git@github.com:danhnguyen123/prayer-studio.git`
Server: Oracle Cloud, Ubuntu, ARM (aarch64), đã cài Docker.

Kiến trúc: container chỉ là **orchestrator nhẹ** (Node + Python + ffmpeg). Việc render
nặng chạy trên **AWS Lambda**, nên container **không cần Chrome** và không cần máy mạnh.

---

## 0) Tổng quan luồng CI/CD

```
push main ──► GitHub Actions ──SSH──► server: git pull → docker compose up -d --build → prune
```

- Build **ngay trên server ARM** (native, không cần registry, không cần buildx/QEMU).
- `.env` **không bao giờ** nằm trong Git hay trong image — chỉ tồn tại trên server.
- Web mở ra **public IP:port** → **BẮT BUỘC bật Basic Auth** + mở firewall đúng cổng.

---

## 1) Chuẩn bị server (làm 1 lần)

```bash
# user riêng cho deploy (không dùng root), thêm vào group docker
sudo adduser --disabled-password deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/prayer-studio && sudo chown deploy:deploy /opt/prayer-studio

# clone repo (dùng deploy key read-only, xem mục 5)
sudo -u deploy git clone git@github.com:danhnguyen123/prayer-studio.git /opt/prayer-studio
```

## 2) Đưa media lên server (câu hỏi 2 — nơi để media)

Không dùng ổ D nữa. Gợi ý: tạo **Block Volume** trên Oracle (free tier có tới ~200GB)
và mount vào `/mnt/media` để tách khỏi ổ boot, cấu trúc:

```
/mnt/media/
├── video/          # footage .mp4/.mov/.webm
├── image/          # ảnh tĩnh .jpg/.png/.webp
└── music/
    └── intro.MP3   # nhạc nền intro
```

Upload từ máy bạn (rsync giữ được tiến độ, chỉ đẩy file mới):

```bash
rsync -avz --progress "D:/Materials/Video 4K/"  deploy@<server>:/mnt/media/video/
rsync -avz --progress "D:/Materials/Pray/Image/" deploy@<server>:/mnt/media/image/
rsync -avz --progress "D:/Materials/Music/intro.MP3" deploy@<server>:/mnt/media/music/
```

> Windows: dùng `scp -r` hoặc WinSCP/FileZilla nếu chưa có rsync.

`docker-compose.yml` đã mount `/mnt/media:/media:ro` (chỉ đọc). Trong `.env` trỏ:

```dotenv
DEFAULT_VIDEO_DIR=/media/video
DEFAULT_IMAGE_DIR=/media/image
DEFAULT_MUSIC_PATH=/media/music/intro.MP3
```

## 3) Tạo `.env` trên server (câu hỏi 1 — copy .env, chống rò rỉ key)

```bash
# copy từ máy bạn lên (KHÔNG commit .env)
scp .env deploy@<server>:/opt/prayer-studio/.env
ssh deploy@<server> 'chmod 600 /opt/prayer-studio/.env'
```

**Cách gộp env:** deploy dùng **2 file** — `.env` (secret của bạn, scp riêng, KHÔNG commit)
và `.env.production` (override cho production, **đã có sẵn trong repo**, không chứa secret).
`docker-compose.yml` khai báo `env_file: [.env, .env.production]` → Compose gộp cả hai vào
môi trường container, **`.env.production` ghi đè** `.env` ở các key trùng. Đây là "1 env chung"
mà server dùng.

Vì vậy `.env` trên server **chỉ cần secrets** (API keys, AWS creds) + Basic Auth; các giá trị
production (`NODE_ENV`, `PYTHON_EXECUTABLE`, `DEFAULT_VIDEO_DIR/IMAGE_DIR/MUSIC_PATH`…) đã nằm
trong `.env.production`, khỏi sửa tay. Chỉ cần thêm vào `.env`:

```dotenv
# BẮT BUỘC khi mở public IP:port — đặt user/mật khẩu mạnh:
APP_BASIC_AUTH_USER=admin
APP_BASIC_AUTH_PASS=<mật-khẩu-mạnh-ngẫu-nhiên>
```

> Muốn đổi đường dẫn media/port cho production thì sửa `.env.production` rồi commit — không
> cần đụng `.env` trên server.

**Bảo mật (quan trọng khi mở public IP:port):**
- `.env`, `API_*.txt` đã nằm trong `.gitignore` **và** `.dockerignore` → không vào Git, không vào image.
- Toàn bộ key chỉ ở backend; **không** đặt biến bắt đầu bằng `VITE_` (sẽ lộ xuống frontend).
- **Bật Basic Auth** (`APP_BASIC_AUTH_USER`/`PASS`): nếu bỏ trống, web không có xác thực và
  bất kỳ ai biết IP:port đều gọi được API → tiêu tiền OpenAI/DeepSeek/AWS của bạn. Server sẽ
  in cảnh báo khi chưa bật.
- `.env` để quyền `600`, thuộc user `deploy`.
- AWS: tạo **IAM user least-privilege** chỉ có quyền trên đúng S3 bucket của Remotion + đúng
  Lambda function, thay vì key toàn quyền. Nếu key từng lỡ commit → rotate ngay.
- Nên đặt cổng lạ (vd `8137` thay vì `4300`) để giảm quét tự động; cân nhắc thêm TLS bằng
  Caddy/nginx trước app nếu cần HTTPS.

## 4) Mở firewall + chạy lần đầu (truy cập public IP:port)

Mở cổng 4300 (hoặc cổng bạn chọn) ở **2 nơi**:

1. **Oracle Cloud** → VCN → Security List (hoặc NSG) của subnet → thêm Ingress Rule:
   Source `0.0.0.0/0`, IP Protocol `TCP`, Destination Port `4300`.
2. **Trên VM (ufw)** nếu đang bật:
   ```bash
   sudo ufw allow 4300/tcp
   ```
   > Oracle Ubuntu còn có iptables mặc định — nếu vẫn không vào được:
   > `sudo iptables -I INPUT -p tcp --dport 4300 -j ACCEPT && sudo netfilter-persistent save`

Chạy:

```bash
ssh deploy@<server>
cd /opt/prayer-studio
mkdir -p data/renders data/output data/logs data/workspace
docker compose up -d --build
docker compose logs -f
```

Mở trên trình duyệt: `http://<PUBLIC_IP>:4300` → nhập user/mật khẩu Basic Auth.

## 5) Bật CI/CD tự động

GitHub repo → **Settings → Secrets and variables → Actions** thêm:

| Secret | Giá trị |
|---|---|
| `SSH_HOST` | IP/hostname server |
| `SSH_USER` | `deploy` |
| `SSH_KEY`  | private key SSH (khớp public key trong `~deploy/.ssh/authorized_keys`) |
| `SSH_PORT` | (tuỳ chọn) mặc định 22 |

Server cần **deploy key read-only** để `git pull`:
```bash
sudo -u deploy ssh-keygen -t ed25519 -f ~deploy/.ssh/id_ed25519 -N ""
# thêm nội dung id_ed25519.pub vào GitHub repo → Settings → Deploy keys (Read only)
```

Từ đó, mỗi lần `push` lên `main`/`master`, workflow `.github/workflows/deploy.yml` tự
SSH vào server, `git pull` → `docker compose up -d --build` → dọn image cũ.

---

## Câu hỏi 3 — Test bằng Docker ở local trước khi deploy

Cần **Docker Desktop** trên Windows (hiện máy bạn chưa có). Sau khi cài:

```powershell
Copy-Item docker-compose.override.yml.example docker-compose.override.yml
# sửa đường dẫn D:\ trong override cho khớp máy bạn
docker compose up --build
# mở http://localhost:4300
```

`docker-compose.override.yml` được compose nạp tự động, ghi đè volume media sang ổ D và
mở cổng 4300 thẳng. Nếu không cài Docker local, có thể build/thử thẳng trên server.

**GitHub cũng tự chạy Docker để test trước khi deploy:** job `build-test` trong
`.github/workflows/deploy.yml` chạy trên runner GitHub (amd64) — `npm typecheck` + `npm test`,
**build Docker image**, rồi **khởi động container và gọi `/api/status`** (smoke test). Job
`deploy` có `needs: build-test` nên **chỉ deploy khi test pass**. Pull Request chỉ chạy test,
không deploy. Vào tab **Actions** trên GitHub để xem kết quả từng lần.

---

## Câu hỏi 4 — Dọn dẹp, tránh phình disk

Thiết kế đã hạn chế phình sẵn:
- `node_modules` nằm trong **layer image** (không phải volume) → không có volume phình theo thời gian.
- Multi-stage: image runtime **bỏ** devDeps (vite/typescript) và build cache.
- `.dockerignore` không copy `node_modules`, media, `renders/`, `output/`… vào build context.
- Log container giới hạn 10MB×3 file.

Lệnh dọn định kỳ (an toàn, **không** đụng volume đang dùng):

```bash
docker image prune -f          # xoá image dangling (CI đã tự chạy)
docker builder prune -af       # xoá build cache
docker system df               # xem dung lượng đang dùng
```

Dọn file đầu ra cũ (video đã tải, log):

```bash
find /opt/prayer-studio/data/renders -type f -mtime +7 -delete
find /opt/prayer-studio/data/logs    -type f -mtime +14 -delete
```

Đặt cron hằng tuần:
```bash
( crontab -l 2>/dev/null; echo '0 3 * * 0 docker image prune -f; docker builder prune -af; find /opt/prayer-studio/data/renders -type f -mtime +7 -delete' ) | crontab -
```

> Tránh `docker system prune --volumes` khi container đang chạy — có thể xoá nhầm dữ liệu.
