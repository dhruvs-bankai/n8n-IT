#!/bin/sh
# Software installer runner, called by n8n's Execute Command node:
#   sh /installers/software-install.sh <slug> <ticket_id> <employee_email>
#
# Phase 1 runs in SIMULATE mode so the automation can be tested without
# touching real machines. To go live, replace the simulated block with the
# command from data/it-config.json -> installation_targets for the target OS
# (winget / brew / apt), or point this at your RMM / Intune / SSH runner.
set -eu

SLUG="${1:?software slug required}"
TICKET="${2:-unknown}"
EMPLOYEE="${3:-unknown}"
LOG_DIR="${SOFTWARE_INSTALL_LOG_DIR:-/runtime/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install-${TICKET}-${SLUG}.log"
SIMULATE="${SIMULATE_INSTALLS:-true}"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG_FILE"
  echo "$*" >&2
}

# Only allowlisted slugs get this far (checked again here, never trust input).
ALLOWED=" chrome firefox 7zip vscode zoom slack notepadpp adobe-acrobat figma autocad "
case "$ALLOWED" in
  *" $SLUG "*) ;;
  *) log "DENIED unknown or not allowlisted package: $SLUG"; echo "denied"; exit 3 ;;
esac

log "ticket=$TICKET employee=$EMPLOYEE package=$SLUG simulate=$SIMULATE"

if [ "$SIMULATE" = "true" ]; then
  log "simulated download for $SLUG ..."
  sleep 2
  log "simulated silent install for $SLUG ... done"
  echo "installed"
  exit 0
fi

# ---- real deployment (example, Debian/Ubuntu) ----
# case "$SLUG" in
#   chrome) PKG=google-chrome-stable ;;
#   vscode) PKG=code ;;
#   zoom)   PKG=zoom ;;
#   *)      PKG="$SLUG" ;;
# esac
# log "running: apt-get install -y $PKG"
# if apt-get install -y "$PKG" >>"$LOG_FILE" 2>&1; then
#   echo "installed"; exit 0
# fi
# echo "failed"; exit 1

log "real install path not configured"
echo "failed"
exit 4
