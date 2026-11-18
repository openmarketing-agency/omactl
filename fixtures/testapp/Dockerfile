FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
ARG APP_VERSION=1.0.0
ENV APP_VERSION=$APP_VERSION
WORKDIR /app
COPY server.ts /app/server.ts
EXPOSE 3000
CMD ["bun", "/app/server.ts"]
