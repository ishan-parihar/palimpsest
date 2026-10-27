#!/usr/bin/env bash
# palimpsest installer.
#
# Order matters and is the whole design: each step is a precondition for the next,
# and the last step is a real gate rather than a hopeful message. Nothing here
# assumes a port, a shared database, or a package manager that this box has.
#
#   1  OS/arch gate        refuse anything that is not linux x86_64|aarch64
#   2  Bun                 official installer, version pinned
#   3  omp 18.3.1          via mise, the way this box has it
#   4  memory-wire v0.5.0  release asset, sha256-verified against the published file
#   5  atlas               verified in place by the counts the test suite pins
#   6  palimpsest          clone, then update if already there
#   7  memory-wire daemon  on an OS-assigned FREE loopback port, this project's own db
#   8  palimpsest doctor   the success assert
#
# Every step is idempotent: a second run re-verifies and skips. Every step exits
# nonzero on failure, so a caller can trust the exit code.
set -euo pipefail

# ---------------------------------------------------------------- defaults ---
BUN_VERSION=1.4.2
OMP_VERSION=18.3.1
MEMORY_WIRE_VERSION=v0.5.0
MEMORY_WIRE_REPO=ishan-parihar/memory-wire
# The atlas is NOT published. https://github.com/ishan-parihar/mental-model-atlas
# returned 404 when this script was written, and the only copy on the author's box
# is an untracked directory under ~/.agents/skills/. So there is no default URL to
# invent: supply --atlas-repo, or pre-populate --atlas-dir. See README.
ATLAS_REPO_DEFAULT=
REPO_URL_DEFAULT=https://github.com/ishan-parihar/palimpsest
INSTALL_DIR=${INSTALL_DIR:-$HOME/.local/share/palimpsest}
ATLAS_DIR=${ATLAS_DIR:-$HOME/.agents/skills/mental-model-atlas}
MEMORY_DB=${MEMORY_DB:-$HOME/.local/share/memory-wire/palimpsest.db}
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}
REPO_URL=$REPO_URL_DEFAULT
ATLAS_REPO=$ATLAS_REPO_DEFAULT
MEMORY_PORT=0
MEMORY_PORT_EXPLICIT=0
WITH_DAEMON=1
# The counts tests/trainer.contract.test.ts pins. A drifted atlas is a substrate
# the trainer cannot reason over, so it is a hard failure here, not a warning.
ATLAS_CARDS=801
ATLAS_T1=191
ATLAS_T2=256
ATLAS_T3=354

# ----------------------------------------------------------------- output ---
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
skip() { printf '   skip  %s\n' "$*"; }
info() { printf '   ..    %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
palimpsest installer

Usage: install/install.sh [flags]

  --install-dir <path>    where the repo is cloned
                          (default: ~/.local/share/palimpsest)
  --repo-url <url|path>   palimpsest source; an http(s) URL is resolved before
                          it is used, a local path is used as-is
                          (default: https://github.com/ishan-parihar/palimpsest)
  --atlas-dir <path>      mental-model-atlas location
                          (default: ~/.agents/skills/mental-model-atlas)
  --atlas-repo <url>      clone the atlas from here when --atlas-dir is empty.
                          No default: the atlas is not published at any public
                          URL, so this is deliberately unset rather than guessed.
  --memory-port <n>       loopback port for the memory-wire daemon. 0 (default)
                          asks the OS for a free port. Never assumes 8888 or
                          18899, and never probes by assuming either is free.
  --memory-db <path>      this project's own database file
                          (default: ~/.local/share/memory-wire/palimpsest.db)
  --bin-dir <path>        where omp / mise / memory-wire are linked
                          (default: ~/.local/bin)
  --bun-version <v>       Bun version to install or accept
                          (default: 1.4.2)
  --omp-version <v>       omp version to install or accept, via mise
                          (default: 18.3.1)
  --no-daemon             install and verify everything, but do not start
                          memory-wire. The final doctor gate then FAILs on
                          memory-wire and the script exits nonzero, which is
                          correct: there is nothing to record into.
  --help                  this text

Environment honoured if already set: BUN_VERSION, OMP_VERSION, INSTALL_DIR,
ATLAS_DIR, MEMORY_DB, BIN_DIR, BUN_INSTALL, MISE_DATA_DIR, MISE_CONFIG_FILE.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)  INSTALL_DIR=${2:?--install-dir needs a value}; shift 2 ;;
    --repo-url)     REPO_URL=${2:?--repo-url needs a value}; shift 2 ;;
    --atlas-dir)    ATLAS_DIR=${2:?--atlas-dir needs a value}; shift 2 ;;
    --atlas-repo)   ATLAS_REPO=${2:?--atlas-repo needs a value}; shift 2 ;;
    --memory-port)  MEMORY_PORT=${2:?--memory-port needs a value}
                    MEMORY_PORT_EXPLICIT=1; shift 2 ;;
    --memory-db)    MEMORY_DB=${2:?--memory-db needs a value}; shift 2 ;;
    --bin-dir)      BIN_DIR=${2:?--bin-dir needs a value}; shift 2 ;;
    --bun-version)  BUN_VERSION=${2:?--bun-version needs a value}; shift 2 ;;
    --omp-version)  OMP_VERSION=${2:?--omp-version needs a value}; shift 2 ;;
    --no-daemon)    WITH_DAEMON=0; shift ;;
    --help|-h)      usage; exit 0 ;;
    *)              usage >&2; die "unknown flag: $1" ;;
  esac
done

command -v curl >/dev/null || die "curl is required"
command -v git  >/dev/null || die "git is required"
command -v tar  >/dev/null || die "tar is required"

# A clone source is either an http(s) URL, which has to answer, or a local path,
# which has to exist. Anything else is refused rather than handed to git, which
# would fail later with a less useful message.
resolve_source() {
  case "$1" in
    http://*|https://*) curl -fsS -o /dev/null -I "$1" 2>/dev/null ;;
    /*|./*|../*|~*)   [ -e "$1" ] || { printf '   ..    %s does not exist\n' "$1" >&2; return 1; } ;;
    *)               return 1 ;;
  esac
}

# mise and Bun both land their shims here; the palimpsest binary is a Bun
# script, so this has to be on PATH before the final gate can run at all.
# MISE_DATA_DIR is honoured because the shims live under the data dir, not under
# $HOME/.local/share -- a caller who redirects mise has redirected its shims too.
MISE_SHIMS="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"
export PATH="$BIN_DIR:$MISE_SHIMS:$PATH"

ensure_path() {  # idempotent: grep before append
  local dir="$1" rc="$HOME/.bashrc"
  case ":$PATH:" in *":$dir:"*) return 0 ;; esac
  if [ -f "$HOME/.zshrc" ] || [ -n "${ZSH_VERSION:-}" ]; then rc="$HOME/.zshrc"; fi
  if ! grep -qs "export PATH=\"$dir:\$PATH\"" "$rc"; then
    printf '\n# added by palimpsest installer\nexport PATH="%s:$PATH"\n' "$dir" >> "$rc"
    printf '>>> generated: %s (PATH export) <<<\n' "$rc"
  fi
}
ensure_path "$BIN_DIR"
ensure_path "$MISE_SHIMS"

# ============================================================== 1. OS gate ===
step "1/8  platform"
OS=$(uname -s)
ARCH=$(uname -m)
[ "$OS" = Linux ] || die "$OS is not supported. palimpsest is verified on linux only (x86_64, aarch64). The memory-wire release publishes no macOS asset: libsqlite3-sys links CoreFoundation, so a mac build must be compiled on a Mac."
case "$ARCH" in
  x86_64|amd64)  MW_ARCH=x86_64  ;;
  aarch64|arm64) MW_ARCH=aarch64 ;;
  *) die "$ARCH is not supported. Refusing rather than guessing a release asset: memory-wire publishes linux-x86_64 and linux-aarch64 only, and omp's own binary is not verified on $ARCH." ;;
esac
ok "linux/$ARCH (memory-wire asset: linux-$MW_ARCH)"

# ================================================================== 2. Bun ===
step "2/8  bun $BUN_VERSION"
have_bun=$(command -v bun >/dev/null && bun --version 2>/dev/null || true)
if [ "$have_bun" = "$BUN_VERSION" ]; then
  ok "bun $have_bun already on PATH"
elif [ -n "$have_bun" ]; then
  ok "bun $have_bun present; the pin is a floor, not a downgrade"
  info "to get exactly $BUN_VERSION: BUN_INSTALL=... bash install.sh --bun-version $BUN_VERSION"
else
  info "installing bun $BUN_VERSION from bun.sh (official installer, pinned tag)"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" \
    || die "the official bun installer failed"
  export BUN_INSTALL=${BUN_INSTALL:-$HOME/.bun}
  export PATH="$BUN_INSTALL/bin:$PATH"
  [ -x "$BUN_INSTALL/bin/bun" ] || command -v bun >/dev/null \
    || die "bun installer reported success but no bun binary is on PATH"
  ok "bun $(bun --version) installed"
fi

# ================================================ 3. omp via mise (as here) ===
# How omp arrived on the author's box: mise, backend `github:can1357/oh-my-pi`,
# resolved to 18.3.1 with the shim on PATH. Reproduced rather than improved, so
# a later `mise upgrade` behaves the same way here as it does there.
step "3/8  omp $OMP_VERSION (mise)"
command -v mise >/dev/null || {
  info "installing mise (official installer)"
  curl -fsSL https://mise.run | sh >/dev/null 2>&1 || die "the official mise installer failed"
  export PATH="$HOME/.local/bin:$PATH"
  command -v mise >/dev/null || die "mise installer reported success but mise is not on PATH"
}
ok "mise $(mise --version 2>/dev/null | head -1)"

omp_version() { "$1" --version 2>/dev/null | sed -n 's|^omp/\([0-9.]*\)$|\1|p' | head -1; }
if [ "$(omp_version "$(command -v omp 2>/dev/null || echo /nonexistent)")" = "$OMP_VERSION" ]; then
  ok "omp $OMP_VERSION already on PATH"
else
  info "mise use -g github:can1357/oh-my-pi@$OMP_VERSION"
  info "note: that rewrites your mise global config, pinning omp there (it replaces a \"latest\" entry)"
  mise use -g "github:can1357/oh-my-pi@$OMP_VERSION" >/dev/null 2>&1 \
    || die "mise could not install omp $OMP_VERSION"
  mise install "github:can1357/oh-my-pi@$OMP_VERSION" >/dev/null 2>&1 || true
  export PATH="$MISE_SHIMS:$PATH"
  got=$(omp_version "$(command -v omp 2>/dev/null || echo /nonexistent)")
  [ "$got" = "$OMP_VERSION" ] || die "expected omp $OMP_VERSION after mise install, got '${got:-none}' on PATH"
  ok "omp $got installed"
fi
[ -n "$ATLAS_DIR" ] || die "ATLAS_DIR cannot be empty"

# ======================================================= 4. memory-wire bin ===
# One binary, from the published release, verified against the checksum file
# published beside the asset. The checksum is fetched from the same release tag
# rather than hardcoded here, so this cannot drift into trusting itself.
step "4/8  memory-wire $MEMORY_WIRE_VERSION"
asset="memory-wire-linux-$MW_ARCH.tar.gz"
base="https://github.com/$MEMORY_WIRE_REPO/releases/download/$MEMORY_WIRE_VERSION"
have_mw=$(command -v memory-wire >/dev/null && memory-wire --version 2>/dev/null | awk '{print $2}' || true)
if [ "$have_mw" = "${MEMORY_WIRE_VERSION#v}" ]; then
  ok "memory-wire $have_mw already on PATH"
else
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  info "fetching $asset"
  curl -fsSL -o "$tmp/$asset" "$base/$asset" || die "could not download $base/$asset"
  curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256" \
    || die "could not download the published checksum $base/$asset.sha256"
  ( cd "$tmp" && grep -F " $asset" "$asset.sha256" | sha256sum -c - ) >/dev/null \
    || die "sha256 mismatch for $asset against the published checksum. Refusing to install it."
  ok "sha256 verified against the release's own checksum file"
  tar xzf "$tmp/$asset" -C "$tmp" || die "could not unpack $asset"
  [ -f "$tmp/memory-wire" ] || die "$asset did not contain a memory-wire binary at its root"
  mkdir -p "$BIN_DIR"
  install -m 0755 "$tmp/memory-wire" "$BIN_DIR/memory-wire" || die "could not install into $BIN_DIR"
  ok "memory-wire $("$BIN_DIR/memory-wire" --version | awk '{print $2}') installed into $BIN_DIR"
fi

# ================================================== 5. the atlas substrate ===
step "5/8  atlas (${ATLAS_CARDS} cards)"
count_atlas() {
  # A card is a `**Tier:** N` marker, which is what src/atlas.ts anchors on --
  # heading level is inconsistent across the atlas, so counting headings reads a
  # fraction of the corpus. The marker sits mid-line, inside a
  # `**Type:** … | **Tier:** N | **Family:** …` row, so it is matched unanchored.
  find "$1" -name 'cards*.md' -type f 2>/dev/null \
    | tr '\n' '\0' | xargs -0 -r grep -ohE '\*\*Tier:\*\* *[0-9]+' 2>/dev/null | wc -l | tr -d ' '
}
tier_atlas() {
  find "$1" -name 'cards*.md' -type f 2>/dev/null \
    | tr '\n' '\0' | xargs -0 -r grep -ohE '\*\*Tier:\*\* *[0-9]+' 2>/dev/null \
    | grep -cE '\*\*Tier:\*\* *'"$2"'$' || true
}
if [ -d "$ATLAS_DIR" ] && [ -n "$(find "$ATLAS_DIR" -name 'cards*.md' -type f 2>/dev/null | head -1)" ]; then
  n=$(count_atlas "$ATLAS_DIR")
  if [ "$n" -eq "$ATLAS_CARDS" ]; then
    ok "atlas at $ATLAS_DIR → $n cards (T1 $(tier_atlas "$ATLAS_DIR" 1) / T2 $(tier_atlas "$ATLAS_DIR" 2) / T3 $(tier_atlas "$ATLAS_DIR" 3))"
  else
    die "atlas at $ATLAS_DIR has $n cards, expected $ATLAS_CARDS. A drifted substrate is not a warning: src/atlas.ts indexes cards*.md and the lattice the trainer propagates over would be a different graph than the one docs/architecture.md describes. Point --atlas-dir at a full copy, or --atlas-repo at a source to clone."
  fi
else
  [ -n "$ATLAS_REPO" ] || die "no atlas at $ATLAS_DIR and no --atlas-repo given. The atlas is deliberately not defaulted to a URL: github.com/ishan-parihar/mental-model-atlas returned 404 when this script was written and the author's copy is an untracked local directory, so there is nothing to clone that this script is entitled to claim exists. Get a copy and either place it at --atlas-dir or pass --atlas-repo <url>."
  resolve_source "$ATLAS_REPO" "--atlas-repo" || die "--atlas-repo $ATLAS_REPO does not resolve (unreachable, 404, or not a local path)"
  git clone --depth 1 "$ATLAS_REPO" "$ATLAS_DIR" || die "cloning the atlas failed"
  n=$(count_atlas "$ATLAS_DIR")
  [ "$n" -eq "$ATLAS_CARDS" ] || die "the atlas cloned from $ATLAS_REPO has $n cards, expected $ATLAS_CARDS"
  ok "atlas cloned to $ATLAS_DIR → $n cards"
fi

# ============================================================ 6. the repo ====
step "6/8  palimpsest"
case "$REPO_URL" in
  http://*|https://*)
    # Refuse the placeholder rather than 404ing three steps later with a message
    # about DNS. OWNER is a literal marker, not a name.
    case "$REPO_URL" in *OWNER*) die "--repo-url still carries the OWNER placeholder ($REPO_URL). Replace it with the real repository, e.g. --repo-url https://github.com/<you>/palimpsest" ;; esac
    info "resolving $REPO_URL"
    resolve_source "$REPO_URL" || die "--repo-url $REPO_URL does not resolve (404 or unreachable). Pass the real clone URL, or a local path."
    ;;
  /*|./*|../*|~*) ;;
  *) die "--repo-url $REPO_URL is neither an http(s) URL nor a local path" ;;
esac
if [ -d "$INSTALL_DIR/.git" ]; then
  info "updating the existing clone at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet --depth 1 origin || die "git fetch failed in $INSTALL_DIR"
  git -C "$INSTALL_DIR" checkout --quiet --force FETCH_HEAD || die "git checkout FETCH_HEAD failed in $INSTALL_DIR"
  ok "updated to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists and is not a git clone. Move it aside; refusing to write into a directory this script did not create."
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "cloning $REPO_URL failed"
  ok "cloned to $INSTALL_DIR @ $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi
[ -x "$INSTALL_DIR/bin/palimpsest" ] || die "$INSTALL_DIR/bin/palimpsest is missing or not executable; that is not a palimpsest checkout"
chmod +x "$INSTALL_DIR/bin/palimpsest" 2>/dev/null || true

# ============================================================== 7. daemon ===
# Two rules, both learned the hard way by the code that reads them:
#   - 8888 is memory-wire's tree-wide default and must never be assumed free.
#   - the db is this project's own, never the shared agents.db, so another
#     project's sweep can never be aimed at this store.
# The port is asked from the OS rather than guessed, and is remembered in
# install-dir/memory.env so a re-run reuses the same daemon instead of orphaning
# a new one on a fresh port every time.
step "7/8  memory-wire daemon"
mkdir -p "$INSTALL_DIR/.install"
MEMENV="$INSTALL_DIR/memory.env"
if [ "$WITH_DAEMON" -eq 0 ]; then
  skip "--no-daemon: nothing started; the doctor gate below will FAIL on memory-wire"
elif [ "$MEMORY_PORT_EXPLICIT" -eq 0 ] && [ -f "$MEMENV" ]; then
  # shellcheck disable=SC1090
  . "$MEMENV"
  MEMORY_PORT=${PALIMPSEST_MEMORY_PORT:-$MEMORY_PORT}
  MEMORY_DB=${PALIMPSEST_MEMORY_DB:-$MEMORY_DB}
  info "reusing the port and db this script recorded: $MEMORY_PORT / $MEMORY_DB"
fi
if [ "$WITH_DAEMON" -eq 1 ]; then
  if [ "$MEMORY_PORT" = 0 ]; then
    # Bind port 0, read back what the kernel handed out, close. The race window
    # is one syscall wide and `daemon start` refuses a bound port anyway, so the
    # failure mode is a loud refusal, not a hijacked daemon.
    MEMORY_PORT=$(bun -e '
      const s = require("node:net").createServer();
      s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });
    ') || die "could not ask the OS for a free loopback port"
    ok "OS assigned free port $MEMORY_PORT (8888 and 18899 were never assumed)"
  else
    ok "using the requested port $MEMORY_PORT"
  fi
  # A recorded port that some unrelated process has since taken would make both
  # the daemon start and the serve fallback fail on an address this install owns
  # by record. Detect that and move, rather than dead-ending the re-run.
  if [ "$MEMORY_PORT_EXPLICIT" -eq 0 ] \
     && [ "$(curl -fsS --max-time 2 "http://127.0.0.1:$MEMORY_PORT/health" 2>/dev/null || true)" != ok ] \
     && ! bun -e '
           const s = require("node:net").createServer();
           s.once("error", () => process.exit(1));
           s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close());
         ' "$MEMORY_PORT" 2>/dev/null; then
    info "the recorded port $MEMORY_PORT is now taken by something that is not memory-wire; probing again"
    MEMORY_PORT=0
    MEMORY_PORT=$(bun -e '
      const s = require("node:net").createServer();
      s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });
    ') || die "could not ask the OS for a free loopback port"
    ok "OS assigned free port $MEMORY_PORT instead"
  fi
  ADDR="127.0.0.1:$MEMORY_PORT"
  health_ok() {
    [ "$(curl -fsS --max-time 2 "http://$ADDR/health" 2>/dev/null || true)" = ok ]
  }
  if health_ok; then
    ok "a memory-wire is already answering ok on $ADDR; reusing it"
    STOP_HINT="memory-wire daemon stop"
  else
    mkdir -p "$(dirname "$MEMORY_DB")"
    STARTED=""
    if memory-wire daemon start --addr "$ADDR" --db "$MEMORY_DB" >"$INSTALL_DIR/.install/daemon-start.log" 2>&1; then
      STARTED=daemon
      ok "memory-wire daemon start --addr $ADDR --db $MEMORY_DB"
      STOP_HINT="memory-wire daemon stop"
    else
      # `daemon start` is `serve` re-execed detached, plus a record in ONE
      # state file ($XDG_DATA_HOME/memory-wire/serve.json). So when any
      # memory-wire daemon is already running, a second one cannot be recorded
      # or stopped, and start refuses -- on any port, not just a taken one.
      # Refusing here is the correct outcome; what would not be correct is
      # stopping somebody else's daemon to make room. So fall back to owning
      # the process ourselves with `serve`, which writes no state file and
      # touches no other daemon. The author's box has a live daemon on 8888,
      # which is exactly the case that path exists for.
      if [ -f "${XDG_DATA_HOME:-$HOME/.local/share}/memory-wire/serve.json" ]; then
        info "a memory-wire daemon already holds the single state file; refusing to stop it"
        info "falling back to 'memory-wire serve' owned by this shell instead"
      else
        cat "$INSTALL_DIR/.install/daemon-start.log" >&2
      fi
      setsid memory-wire serve --addr "$ADDR" --db "$MEMORY_DB" >"$INSTALL_DIR/.install/serve.log" 2>&1 &
      SERVE_PID=$!
      for _ in $(seq 1 40); do health_ok && break; sleep 0.25; done
      health_ok || { cat "$INSTALL_DIR/.install/serve.log" >&2
        die "memory-wire serve on $ADDR never answered /health with exactly 'ok'. Log: $INSTALL_DIR/.install/serve.log"; }
      STARTED=serve
      ok "memory-wire serve --addr $ADDR --db $MEMORY_DB (pid $SERVE_PID, own session)"
      STOP_HINT="kill $SERVE_PID"
    fi
    health_ok || die "memory-wire on $ADDR did not return exactly 'ok' on /health. A 200 from some other process does not count, which is why this is a body comparison and not a status-code check."
    ok "serving, /health returns exactly ok"
  fi
  if [ -f "$INSTALL_DIR/memory.env" ] && grep -qs "PALIMPSEST_MEMORY_PORT=$MEMORY_PORT" "$INSTALL_DIR/memory.env"; then
    info "$MEMENV already records port $MEMORY_PORT and db $MEMORY_DB"
  else
  mkdir -p "$INSTALL_DIR"
  cat >"$MEMENV" <<EOF
# Written by install/install.sh. Source it, or export these yourself.
# palimpsest reads PALIMPSEST_MEMORY_ADDR and deliberately does NOT read
# MEMORY_WIRE_URL -- that one is set for every memory-wire consumer on the box
# and honouring it let a foreign export redirect where records are written.
export PALIMPSEST_MEMORY_ADDR=http://$ADDR
export PALIMPSEST_MEMORY_PORT=$MEMORY_PORT
export PALIMPSEST_MEMORY_DB=$MEMORY_DB
export PATH="$BIN_DIR:$MISE_SHIMS:\$PATH"
# stop this install's memory-wire: $STOP_HINT
EOF
  ok "recorded in $MEMENV"
  fi
else
  ADDR=127.0.0.1:0
fi

# =============================================================== 8. doctor ===
# The assert. `palimpsest doctor` runs eight independent subsystem checks,
# mutates nothing, and exits nonzero if any FAIL. One FAIL is not a fault on a
# machine that has simply never trained: the `sessions` check reads
# ~/.omp/agent/sessions/<project>, which is created by the first session. That one
# line is expected until the user has actually trained; every other FAIL is real
# and stops the install.
step "8/8  palimpsest doctor (the gate)"
doctor_bin="$INSTALL_DIR/bin/palimpsest"
if [ "$WITH_DAEMON" -eq 1 ]; then
  set +e
  out=$(cd "$INSTALL_DIR" && PALIMPSEST_MEMORY_ADDR="http://$ADDR" "$doctor_bin" doctor 2>&1)
  code=$?
  set -e
else
  out=$(cd "$INSTALL_DIR" && "$doctor_bin" doctor 2>&1) && code=0 || code=$?
fi
printf '%s\n' "$out"
fails=$(printf '%s\n' "$out" | grep -c '^FAIL' || true)
only_sessions=1
if [ "$fails" -ne 0 ]; then
  # shellcheck disable=SC2002
  other=$(printf '%s\n' "$out" | grep '^FAIL' | grep -vc '^FAIL  sessions ' || true)
  [ "$other" -eq 0 ] || only_sessions=0
fi
if [ "$code" -eq 0 ]; then
  ok "doctor: all subsystems PASS"
elif [ "$only_sessions" -eq 1 ] && [ "$WITH_DAEMON" -eq 1 ]; then
  ok "doctor: every subsystem PASS except 'sessions', which reads a directory the first session creates"
  info "expected on a fresh install. Run 'palimpsest' and train once, then re-run this script: doctor goes green."
else
  die "palimpsest doctor failed (exit $code, $fails failing line(s)). Everything above it is fixed; the FAIL lines above name the address or path each check looked at, so start there."
fi

printf '\n\033[1minstalled.\033[0m\n'
cat <<EOF
  source $MEMENV
  cd $INSTALL_DIR && ./bin/palimpsest        # train. the trainer asks; you answer.
  ./bin/palimpsest state                     # what has been assimilated so far
  ./bin/palimpsest doctor                    # eight subsystem checks, nonzero on any FAIL
  ./bin/palimpsest digest <file>             # one-shot, records to state/assimilation.log
  ./bin/palimpsest settle integrated         # the verdict is yours, never the trainer's

  memory-wire: http://$ADDR  db $MEMORY_DB
  stop it:    $STOP_HINT
EOF

print_cta() {
  [ "${SKIP_CTA:-0}" = "1" ] && return 0
  printf '\n%s\n' "──────────────────────────────────────────────────────"
  printf ' ⭐  Found palimpsest useful? Star it:  https://github.com/ishan-parihar/palimpsest\n'
  printf ' 💜  Support development:\n'
  printf '     GitHub Sponsors : https://github.com/sponsors/ishan-parihar\n'
  printf '     Razorpay (UPI)  : https://rzp.io/rzp/ishan-parihar\n'
  printf '%s\n' "──────────────────────────────────────────────────────"
}
SKIP_CTA="${SKIP_CTA:-0}"
case "${1:-}" in --no-cta) SKIP_CTA=1 ;; esac
print_cta