# SPDX-License-Identifier: Apache-2.0
.PHONY: dev dev-api dev-web test test-go test-web test-e2e lint typecheck gen golden build docker docker-key release-snapshot

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
PNPM = pnpm --dir web

# Vite serves 4317 and proxies the API to 4327, because 4318 is the OpenTelemetry HTTP default.
dev:
	@$(MAKE) -j2 dev-api dev-web

dev-api:
	MABARI_PORT=4327 go tool air

dev-web:
	$(PNPM) dev

test: test-go test-web test-e2e

test-go:
	go test -race ./...

test-web:
	$(PNPM) test

test-e2e:
	$(PNPM) test:e2e

lint:
	golangci-lint run
	$(PNPM) lint

typecheck:
	go vet ./...
	$(PNPM) typecheck

gen:
	go tool tygo generate
	$(PNPM) tokens

# Records the prototype's demo office for the simulator's golden test.
golden:
	node web/scripts/gen-sim-golden.mjs

build:
	$(PNPM) build
	CGO_ENABLED=0 go build -tags embedweb -trimpath \
		-ldflags "-s -w -X main.version=$(VERSION)" -o bin/mabari ./cmd/mabari

docker-key:
	@test -f deploy/docker/mabari_master_key || \
		(umask 077 && openssl rand -base64 32 > deploy/docker/mabari_master_key && \
		echo "Wrote deploy/docker/mabari_master_key. Keep it: without it the stored keys can't be read.")

docker:
	docker build -f deploy/docker/Dockerfile -t mabari:dev --build-arg VERSION=$(VERSION) .

release-snapshot:
	@echo "GoReleaser arrives in Stage 11."
