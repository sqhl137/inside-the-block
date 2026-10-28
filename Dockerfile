FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
# keys arrive ONLY via volume/env (bounty rule): docker compose mounts ./keys read-only
ENV KEYPAIR_PATH=/keys/keypair.json
ENV DATA_DIR=/app/data
CMD ["npx", "tsx", "src/run.ts", "probe"]
