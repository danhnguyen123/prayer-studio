# syntax=docker/dockerfile:1

# ---- Build stage: dựng frontend (Vite -> dist) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
# ffmpeg/ffprobe: đọc thời lượng media + xoá metadata sau render.
# python3: engine viết kịch bản (run.py). Không cần Chrome vì render chạy trên AWS Lambda.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Chỉ cài dependencies production (bỏ vite/typescript devDeps) cho image gọn.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Python deps
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Mã nguồn app + dữ liệu tĩnh cần cho runtime
COPY server ./server
COPY remotion ./remotion
COPY src ./src
COPY configs ./configs
COPY personas ./personas
COPY run.py ./run.py
COPY --from=build /app/dist ./dist

# Thư mục ghi runtime (được mount volume trong compose để bền + dễ dọn)
RUN mkdir -p output samples logs renders workspace/uploads

EXPOSE 4300
CMD ["node", "server/index.mjs"]
