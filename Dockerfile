FROM node:22-bookworm-slim
ARG DNSX_VERSION=1.3.1
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) ARCH=amd64 ;; arm64) ARCH=arm64 ;; *) echo "Unsupported arch ${TARGETARCH}"; exit 1 ;; esac; \
    curl -fL "https://github.com/projectdiscovery/dnsx/releases/download/v${DNSX_VERSION}/dnsx_${DNSX_VERSION}_linux_${ARCH}.zip" -o /tmp/dnsx.zip; \
    unzip /tmp/dnsx.zip -d /app/tools; \
    chmod +x /app/tools/dnsx; \
    rm -f /tmp/dnsx.zip
ENV PORT=3000 HOST=0.0.0.0 DNSX_PATH=/app/tools/dnsx
EXPOSE 3000
CMD ["node", "server.js"]
