#!/usr/bin/env bash
# One-click installer and launcher for @cloudflare/computer Desktop environment.
# Automatically detects Docker, downloads/loads the image from GitHub Releases,
# resolves port conflicts, starts the container, and verifies health.

set -Eeuo pipefail

NAME="computer-desktop"
IMAGE="computerd-desktop:latest"
PORT="8080"
NOVNC_PORT="6080"
VNC_PORT="5900"
RESOLUTION="1280x720x24"
SECRET="local-dev-secret"
TAR_FILE=""
DOWNLOAD_URL=""
FORCE_RESTART=false
GITHUB_REPO="NannaOlympicBroadcast/computer"
RELEASE_TAG="continuous"

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_banner() {
  cat << "EOF"
  ____                            _            
 / ___|___  _ __ ___  _ __  _   _| |_ ___ _ __ 
| |   / _ \| '_ ` _ \| '_ \| | | | __/ _ \ '__|
| |__| (_) | | | | | | |_) | |_| | ||  __/ |   
 \____\___/|_| |_| |_| .__/ \__,_|\__\___|_|   
                     |_|                       
 Cloudflare Computer — Cloud Desktop Installer
EOF
}

usage() {
  cat << EOF
Usage: $0 [options]

Options:
  -p, --port <port>         computerd RPC port (default: 8080, auto-fallback if busy)
  --novnc-port <port>       noVNC web desktop port (default: 6080, auto-fallback if busy)
  --vnc-port <port>         x11vnc RFB port (default: 5900)
  -s, --secret <secret>     RPC bearer token secret (default: local-dev-secret)
  -n, --name <name>         Container name (default: computer-desktop)
  -t, --tar <file>          Path to prebuilt computerd-desktop image tar/tar.gz
  --download-url <url>      Direct URL to download image tarball before loading
  --repo <owner/repo>       GitHub repo for Releases download (default: NannaOlympicBroadcast/computer)
  --tag <release-tag>       GitHub Release tag to download (default: continuous)
  -r, --resolution <res>    Virtual screen resolution (default: 1280x720x24)
  -f, --force               Force remove existing container with same name
  -h, --help                Show this help message
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) PORT="$2"; shift 2 ;;
    --novnc-port) NOVNC_PORT="$2"; shift 2 ;;
    --vnc-port) VNC_PORT="$2"; shift 2 ;;
    -s|--secret) SECRET="$2"; shift 2 ;;
    -n|--name) NAME="$2"; shift 2 ;;
    -t|--tar) TAR_FILE="$2"; shift 2 ;;
    --download-url) DOWNLOAD_URL="$2"; shift 2 ;;
    --repo) GITHUB_REPO="$2"; shift 2 ;;
    --tag) RELEASE_TAG="$2"; shift 2 ;;
    -r|--resolution) RESOLUTION="$2"; shift 2 ;;
    -f|--force) FORCE_RESTART=true; shift ;;
    -h|--help) usage ;;
    *) echo -e "${RED}Unknown option: $1${NC}" >&2; usage ;;
  esac
done

print_banner

echo -e "\n${BLUE}==> [1/5] Checking Docker environment...${NC}"
if ! command -v docker >/dev/null 2>&1; then
  echo -e "${RED}Error: Docker is not installed on this system.${NC}"
  echo "Please install Docker first: https://docs.docker.com/engine/install/"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo -e "${YELLOW}Notice: Accessing Docker daemon requires elevated privileges.${NC}"
  if command -v sudo >/dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
  else
    echo -e "${RED}Error: Docker daemon is not accessible.${NC}"
    exit 1
  fi
else
  DOCKER_CMD="docker"
fi
echo -e "${GREEN}Docker is ready: $($DOCKER_CMD --version)${NC}"

# Check and load Docker image
echo -e "\n${BLUE}==> [2/5] Preparing container image ($IMAGE)...${NC}"

# 1. Custom download URL provided
if [[ -n "$DOWNLOAD_URL" ]]; then
  TMP_TAR="/tmp/computerd-desktop-download.tar.gz"
  echo -e "Downloading prebuilt image from ${CYAN}${DOWNLOAD_URL}${NC}..."
  curl -fsSL --progress-bar -o "$TMP_TAR" "$DOWNLOAD_URL"
  TAR_FILE="$TMP_TAR"
fi

# 2. Search local candidate files if not explicitly given
if [[ -z "$TAR_FILE" ]]; then
  for candidate in \
    "./computerd-desktop-linux-amd64.tar.gz" \
    "./computerd-desktop.tar.gz" \
    "./dist-image/computerd-desktop-linux-amd64.tar.gz" \
    "../dist-image/computerd-desktop-linux-amd64.tar.gz" \
    "/tmp/computerd-desktop-linux-amd64.tar.gz"; do
    if [[ -f "$candidate" ]]; then
      TAR_FILE="$candidate"
      break
    fi
  done
fi

# 3. Load image from local tar if found
if [[ -n "$TAR_FILE" && -f "$TAR_FILE" ]]; then
  echo -e "Loading image from local archive: ${CYAN}${TAR_FILE}${NC}..."
  if [[ "$TAR_FILE" =~ \.gz$ ]]; then
    gzip -dc "$TAR_FILE" | $DOCKER_CMD load
  else
    $DOCKER_CMD load -i "$TAR_FILE"
  fi
elif ! $DOCKER_CMD image inspect "$IMAGE" >/dev/null 2>&1; then
  # 4. If image still missing, attempt downloading from GitHub Release
  RELEASE_TAR_URL="https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}/computerd-desktop-linux-amd64.tar.gz"
  TMP_RELEASE_TAR="/tmp/computerd-desktop-release.tar.gz"
  
  echo -e "Checking prebuilt image from GitHub Release: ${CYAN}${RELEASE_TAR_URL}${NC}..."
  if curl --head --silent --fail "$RELEASE_TAR_URL" >/dev/null 2>&1; then
    echo -e "Downloading prebuilt image tarball from GitHub Release..."
    curl -fL --progress-bar -o "$TMP_RELEASE_TAR" "$RELEASE_TAR_URL"
    echo -e "Extracting and importing Docker image..."
    gzip -dc "$TMP_RELEASE_TAR" | $DOCKER_CMD load
    rm -f "$TMP_RELEASE_TAR"
  else
    # 5. Fallback: check if we are in local source repo and build
    REPO_DIR=""
    if [[ -f "packages/computerd/Dockerfile.desktop" ]]; then
      REPO_DIR="."
    elif [[ -f "../packages/computerd/Dockerfile.desktop" ]]; then
      REPO_DIR=".."
    fi

    if [[ -n "$REPO_DIR" ]]; then
      echo -e "${YELLOW}Building locally from source repository ($REPO_DIR)...${NC}"
      $DOCKER_CMD build -f "$REPO_DIR/packages/computerd/Dockerfile.desktop" -t "$IMAGE" "$REPO_DIR"
    else
      echo -e "${RED}Error: Prebuilt image $IMAGE not found locally, and no release asset at $RELEASE_TAR_URL.${NC}"
      echo "Options:"
      echo "  1. Download manually and pass: $0 --tar <path-to-tar.gz>"
      echo "  2. Pass a custom download URL: $0 --download-url <url>"
      exit 1
    fi
  fi
else
  echo -e "${GREEN}Image $IMAGE is already available.${NC}"
fi

# Port conflict detection
is_port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln | grep -qE "[:.]${p}\s" && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$p" 2>/dev/null && return 0
  fi
  return 1
}

find_available_port() {
  local desired="$1"
  local fallback="$2"
  if is_port_in_use "$desired"; then
    echo -e "${YELLOW}Notice: Port $desired is in use. Falling back to port $fallback.${NC}" >&2
    if is_port_in_use "$fallback"; then
      for candidate in $(seq 18080 18099); do
        if ! is_port_in_use "$candidate"; then
          echo "$candidate"
          return 0
        fi
      done
    else
      echo "$fallback"
      return 0
    fi
  fi
  echo "$desired"
}

echo -e "\n${BLUE}==> [3/5] Resolving network port bindings...${NC}"
ACTUAL_PORT=$(find_available_port "$PORT" "18080")
ACTUAL_NOVNC_PORT=$(find_available_port "$NOVNC_PORT" "16080")
ACTUAL_VNC_PORT="$VNC_PORT"

echo "RPC Port:       $ACTUAL_PORT (container: 8080)"
echo "noVNC Web:      $ACTUAL_NOVNC_PORT (container: 6080)"
echo "VNC Port:       $ACTUAL_VNC_PORT (container: 5900)"

# Manage container lifecycle
echo -e "\n${BLUE}==> [4/5] Launching container ($NAME)...${NC}"
if $DOCKER_CMD ps -a --format '{{.Names}}' | grep -Eq "^${NAME}\$"; then
  echo "Stopping and replacing existing container '$NAME'..."
  $DOCKER_CMD rm -f "$NAME" >/dev/null 2>&1 || true
fi

$DOCKER_CMD run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --privileged \
  -p "${ACTUAL_PORT}:8080" \
  -p "${ACTUAL_NOVNC_PORT}:6080" \
  -p "${ACTUAL_VNC_PORT}:5900" \
  -e "DESKTOP_ENABLED=1" \
  -e "DESKTOP_RESOLUTION=${RESOLUTION}" \
  -e "RPC_CLIENT_SECRET=${SECRET}" \
  "$IMAGE" >/dev/null

echo -e "${GREEN}Container started successfully.${NC}"

# Health check probe
echo -e "\n${BLUE}==> [5/5] Waiting for computerd daemon to become ready...${NC}"
READY=false
for i in $(seq 1 30); do
  if curl -s -f "http://127.0.0.1:${ACTUAL_PORT}/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" = true ]; then
  echo -e "${GREEN}Health check passed! computerd is ready.${NC}"
else
  echo -e "${YELLOW}Warning: Health check timed out after 30s. Checking container logs:${NC}"
  $DOCKER_CMD logs --tail 20 "$NAME"
fi

# Detect host IP & Tailscale IP
LAN_IP="127.0.0.1"
if command -v hostname >/dev/null 2>&1; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
fi

TAILSCALE_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
fi

echo -e "\n${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}        Cloudflare Computer Cloud Desktop Ready!                ${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "Container Name:    ${BOLD}${NAME}${NC}"
echo -e "Secret Token:      ${BOLD}${SECRET}${NC}"
echo -e "Local RPC Endpoint:${CYAN}http://127.0.0.1:${ACTUAL_PORT}${NC}"
echo -e "noVNC Live Desktop:${CYAN}http://127.0.0.1:${ACTUAL_NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale${NC}"

if [[ -n "$LAN_IP" && "$LAN_IP" != "127.0.0.1" ]]; then
  echo -e "LAN noVNC URL:     ${CYAN}http://${LAN_IP}:${ACTUAL_NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale${NC}"
fi

if [[ -n "$TAILSCALE_IP" ]]; then
  echo -e "Tailnet noVNC URL: ${CYAN}http://${TAILSCALE_IP}:${ACTUAL_NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale${NC}"
fi
echo -e "${GREEN}${BOLD}================================================================${NC}\n"
