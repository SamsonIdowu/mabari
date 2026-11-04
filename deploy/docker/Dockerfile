# SPDX-License-Identifier: Apache-2.0
# First version, so Docker never drifts behind. Finished in Stage 10.

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
RUN mkdir -p /data

FROM gcr.io/distroless/static:nonroot
COPY --from=server /mabari /mabari
COPY --from=server --chown=65532:65532 /data /data
# Docker networking needs 0.0.0.0 here. Compose publishes the port on 127.0.0.1 only.
ENV MABARI_BIND=0.0.0.0 MABARI_IN_CONTAINER=1 MABARI_DATA_DIR=/data
EXPOSE 4317
VOLUME /data
ENTRYPOINT ["/mabari", "serve"]
