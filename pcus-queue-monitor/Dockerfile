FROM golang:1.25-bookworm AS build

WORKDIR /src
COPY engine/go.mod engine/go.sum ./
RUN go mod download
COPY engine/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/pcus-queue-monitor ./cmd/pcus-session-poc

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/pcus-queue-monitor /usr/local/bin/pcus-queue-monitor

ENV PORT=8080
ENV HOLD_S=0
ENV POLL_S=10
ENV DUMP=/data/snapshots

CMD ["pcus-queue-monitor"]
