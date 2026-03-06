FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=builder /app .
EXPOSE 8443
CMD ["bun", "run", "src/app.ts"]
