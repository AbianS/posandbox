FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
RUN npm install -g pnpm@12.4.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY e2e e2e
COPY fixtures fixtures
COPY src/shared src/shared
CMD ["pnpm", "exec", "playwright", "test", "-c", "e2e/playwright.config.ts"]
