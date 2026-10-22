FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.6.0 AS computerd

FROM node:22-trixie-slim

# libfuse2t64 is for the pinned binary while that tag is 0.6.0 or earlier,
# which link libfuse 2. Later releases need only fuse3, at libfuse 3.17
# or newer (Debian trixie); drop libfuse2t64 once the tag is past 0.6.0.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl fuse3 git libfuse2t64 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
