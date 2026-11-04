# SPDX-License-Identifier: Apache-2.0
# Two images from one file:
#   default        distroless, about 25 MB: the office, the simulator, hooks from the host
#   --target agents  Debian slim with the Claude Code and Codex CLIs, to run agents inside

FROM node:22-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.27-alpine AS server
WORKDIR /src
ARG VERSION=dev
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/*.go web/
COPY --from=web /src/web/dist web/dist
RUN CGO_ENABLED=0 go build -tags embedweb -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" -o /mabari ./cmd/mabari
# Distroless has no shell, so the data folder is made here and copied in with its owner.
RUN mkdir -p /data /workspace

# whisper.cpp, only when WHISPER_CPP_VERSION is given, for the agents image.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=
RUN mkdir -p /out && if [ -n "$WHISPER_CPP_VERSION" ]; then \
      apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates && \
      git clone --depth 1 --branch "v${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp /whisper && \
      cmake -S /whisper -B /whisper/build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF && \
      cmake --build /whisper/build --config Release --target whisper-cli -j && \
      cp /whisper/build/bin/whisper-cli /out/; \
    fi

FROM node:22-bookworm-slim AS agents
# Pinned to the versions Mabari was tested with. See docs/INTEGRATIONS.md.
ARG CLAUDE_CODE_VERSION=2.1.318
ARG CODEX_VERSION=0.166.0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    # npm, yarn and corepack were only needed to install; their bundled packages carry CVEs.
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=server /mabari /usr/local/bin/mabari
COPY --from=whisper /out/ /usr/local/bin/
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
# MABARI_AGENTS_IMAGE: Claude Code runs in here, so Connect writes this container's ~/.claude.
ENV MABARI_BIND=0.0.0.0 MABARI_IN_CONTAINER=1 MABARI_AGENTS_IMAGE=1 MABARI_DATA_DIR=/data
EXPOSE 4317
VOLUME ["/data", "/home/node"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["mabari", "healthcheck"]
ENTRYPOINT ["tini", "--", "mabari", "serve"]

FROM gcr.io/distroless/static:nonroot
COPY --from=server /mabari /mabari
COPY --from=server --chown=65532:65532 /data /data
COPY --from=server --chown=65532:65532 /workspace /workspace
# Docker networking needs 0.0.0.0 here. Compose publishes the port on 127.0.0.1 only.
ENV MABARI_BIND=0.0.0.0 MABARI_IN_CONTAINER=1 MABARI_DATA_DIR=/data
EXPOSE 4317
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/mabari", "healthcheck"]
ENTRYPOINT ["/mabari", "serve"]
