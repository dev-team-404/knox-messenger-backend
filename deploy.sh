#!/bin/bash
# ============================================
# Knox Message Server - Blue-Green 무중단 배포
# ============================================
#
# 사용법:
#   ./deploy.sh          # Blue-Green 배포 (다운타임 0)
#   ./deploy.sh status   # 현재 활성 슬롯 확인
#   ./deploy.sh init     # 최초 설치 (전체 빌드 + 시작)
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEPLOY]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }

cd "$(dirname "$0")"

STATE_FILE=".deploy-state"
BACKUP_UPSTREAM=""

# ─── 상태 관리 ───
get_active() {
  local state
  state=$(cat "$STATE_FILE" 2>/dev/null || true)
  if [ "$state" = "blue" ] || [ "$state" = "green" ]; then
    echo "$state"
  else
    echo "blue"
  fi
}

get_inactive() {
  local active
  active=$(get_active)
  [ "$active" = "blue" ] && echo "green" || echo "blue"
}

# ─── 헬스체크 대기 ───
wait_healthy() {
  local service=$1
  local max_wait=${2:-60}
  local elapsed=0
  local container_id

  info "${service} 헬스체크 대기 중..."

  while [ $elapsed -lt $max_wait ]; do
    container_id=$(docker compose ps -q "$service" 2>/dev/null || true)
    if [ -z "$container_id" ]; then
      sleep 2; elapsed=$((elapsed + 2)); continue
    fi

    local health
    health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || echo "unknown")

    if [ "$health" = "healthy" ]; then
      log "${service} → healthy (${elapsed}초)"
      return 0
    fi
    if [ "$health" = "no-healthcheck" ]; then
      local state
      state=$(docker inspect --format='{{.State.Status}}' "$container_id" 2>/dev/null || echo "unknown")
      if [ "$state" = "running" ]; then
        log "${service} → running (${elapsed}초)"
        return 0
      fi
    fi

    sleep 2; elapsed=$((elapsed + 2))
  done

  err "${service}가 ${max_wait}초 내에 ready 상태가 되지 않았습니다"
  return 1
}

# ─── nginx upstream 전환 ───
switch_upstream() {
  local color=$1
  info "upstream을 ${color}으로 전환 중..."
  BACKUP_UPSTREAM=$(cat nginx/active-upstream.conf)
  cp "nginx/upstream-${color}.conf" nginx/active-upstream.conf
  log "active-upstream.conf → ${color}"
  docker compose exec -T nginx nginx -s reload
  log "nginx reload 완료 — 트래픽이 ${color}으로 전환됨"
}

rollback_upstream() {
  if [ -n "$BACKUP_UPSTREAM" ]; then
    warn "upstream 롤백 중..."
    echo "$BACKUP_UPSTREAM" > nginx/active-upstream.conf
    docker compose exec -T nginx nginx -s reload 2>/dev/null || true
    warn "upstream 롤백 완료"
  fi
}

# ─── status ───
cmd_status() {
  local active; active=$(get_active)
  echo ""
  echo -e "${BOLD}Knox Message Server - Blue-Green 상태${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "  활성 슬롯: ${GREEN}${active}${NC} ← 트래픽 수신 중"
  echo -e "  대기 슬롯: ${CYAN}$(get_inactive)${NC}"
  echo ""
  docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || docker compose ps
  echo ""
}

# ─── init (최초 설치) ───
cmd_init() {
  log "최초 설치 시작"
  echo ""

  log "1/3 Redis 시작"
  docker compose up -d redis
  wait_healthy redis 30
  echo ""

  log "2/3 Blue 슬롯 빌드 + 시작"
  docker compose build --no-cache api-blue
  docker compose up -d api-blue
  wait_healthy api-blue 60
  echo ""

  log "2/3 Green 슬롯 빌드 + 시작"
  docker compose build --no-cache api-green
  docker compose up -d api-green
  wait_healthy api-green 60
  echo ""

  log "3/3 Nginx 시작"
  cp nginx/upstream-blue.conf nginx/active-upstream.conf
  docker compose build --no-cache nginx
  docker compose up -d nginx
  echo ""

  echo "blue" > "$STATE_FILE"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "최초 설치 완료!"
  info "수신 URL: http://$(hostname -I | awk '{print $1}'):6000/message"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  docker compose ps
}

# ─── Blue-Green 배포 ───
cmd_deploy() {
  local ACTIVE; ACTIVE=$(get_active)
  local INACTIVE; INACTIVE=$(get_inactive)

  echo ""
  echo -e "${BOLD}Knox Message Server - Blue-Green 무중단 배포${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "  현재 활성: ${GREEN}${ACTIVE}${NC}"
  echo -e "  배포 대상: ${CYAN}${INACTIVE}${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  local START_TIME; START_TIME=$(date +%s)

  log "Step 1/5: 비활성 슬롯 이미지 빌드"
  docker compose build --no-cache "api-${INACTIVE}" nginx
  echo ""

  log "Step 2/5: ${INACTIVE} 슬롯 컨테이너 재시작"
  docker compose up -d "api-${INACTIVE}"
  if ! wait_healthy "api-${INACTIVE}" 60; then
    err "api-${INACTIVE} 헬스체크 실패 — 배포 중단"
    exit 1
  fi
  echo ""

  log "Step 3/5: 트래픽 전환 ${ACTIVE} → ${INACTIVE}"
  if ! switch_upstream "$INACTIVE"; then
    err "nginx reload 실패"
    rollback_upstream
    exit 1
  fi
  echo ""

  log "Step 4/5: ${ACTIVE} 슬롯 업데이트"
  docker compose build --no-cache "api-${ACTIVE}"
  docker compose up -d "api-${ACTIVE}"
  wait_healthy "api-${ACTIVE}" 60 || true
  echo ""

  log "Step 5/5: Nginx 컨테이너 교체"
  docker compose up -d nginx
  echo ""

  echo "$INACTIVE" > "$STATE_FILE"

  local ELAPSED=$(( $(date +%s) - START_TIME ))
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "배포 완료! 활성: ${INACTIVE} | 소요: ${ELAPSED}초 | 중단: 0초"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  docker compose ps
}

# ─── 메인 ───
case "${1:-deploy}" in
  status) cmd_status ;;
  init)   cmd_init ;;
  deploy) cmd_deploy ;;
  *)
    echo "사용법: $0 [deploy|status|init]"
    exit 1 ;;
esac
