#!/bin/sh
set -e

# SKC Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jaybeyond/Sayknow_CLI/main/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="jaybeyond/Sayknow_CLI"
PACKAGE="@sayknow-cli/coding-agent"
INSTALL_DIR="${SKC_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"
BINARY_SHA256_ASSET="sayknow-release-binaries.sha256"
LOCK_DIR=""
LOCK_OWNED=""
DOWNLOAD_TMP=""
INTEGRITY_TMP=""

cleanup_install() {
    [ -z "$DOWNLOAD_TMP" ] || rm -f "$DOWNLOAD_TMP"
    [ -z "$INTEGRITY_TMP" ] || rm -f "$INTEGRITY_TMP"
    [ -z "$LOCK_OWNED" ] || rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_install EXIT HUP INT TERM

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    echo ""
    echo "✓ Installed skc via bun"
    echo "Run 'skc' to get started!"
}

file_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "No SHA-256 tool found (need sha256sum or shasum)" >&2
        return 1
    fi
}

fetch_integrity_asset() {
    url="$1"
    out="$2"
    curl -sSL --retry 2 --retry-delay 1 -A "skc-install" -o "$out" -w "%{http_code}" "$url"
}

verify_binary_checksum() {
    asset_name="$1"
    downloaded="$2"
    sums_url="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY_SHA256_ASSET}"
    INTEGRITY_TMP=$(mktemp "${INSTALL_DIR}/.skc.integrity.XXXXXX")

    if ! http_code=$(fetch_integrity_asset "$sums_url" "$INTEGRITY_TMP"); then
        echo "Failed to fetch integrity asset $sums_url. Existing install was not changed." >&2
        exit 1
    fi
    if [ "$http_code" != "200" ]; then
        if [ "$http_code" = "404" ]; then
            echo "Release ${LATEST} has no Sayknow binary integrity manifest. Existing install was not changed." >&2
        else
            echo "Integrity asset returned HTTP ${http_code}. Existing install was not changed." >&2
        fi
        exit 1
    fi
    expected_lines=$(awk -v name="$asset_name" '$2 == name || $2 == "*" name { print tolower($1) }' "$INTEGRITY_TMP")
    expected_count=$(printf '%s\n' "$expected_lines" | awk 'NF { count++ } END { print count + 0 }')
    if [ "$expected_count" -ne 1 ]; then
        echo "Integrity manifest did not list exactly one SHA-256 for ${asset_name}. Existing install was not changed." >&2
        exit 1
    fi
    expected="$expected_lines"

    if ! printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "Integrity manifest did not list one valid SHA-256 for ${asset_name}. Existing install was not changed." >&2
        exit 1
    fi
    actual=$(file_sha256 "$downloaded")
    if [ "$actual" != "$expected" ]; then
        echo "SHA-256 mismatch for ${asset_name}. Existing install was not changed." >&2
        exit 1
    fi
    echo "Verified SHA-256 for ${asset_name}"
    rm -f "$INTEGRITY_TMP"
    INTEGRITY_TMP=""
}

acquire_install_lock() {
    LOCK_DIR="${INSTALL_DIR}/.skc-install.lock"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "Another SKC installer is already running in ${INSTALL_DIR} (lock: ${LOCK_DIR})." >&2
        exit 1
    fi
    LOCK_OWNED="1"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY="skc-${PLATFORM}-${ARCH}"
    # Resolve only canonical Sayknow release tags. The latest endpoint exposes
    # the selected tag in its final redirect URL, avoiding heuristic JSON parsing.
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        LATEST="$REF"
    else
        echo "Fetching latest release..."
        if ! latest_url=$(curl -fsSL -o /dev/null -w "%{url_effective}" "https://github.com/${REPO}/releases/latest"); then
            echo "Failed to resolve the latest Sayknow release"
            exit 1
        fi
        LATEST="${latest_url##*/}"
    fi
    if ! printf '%s\n' "$LATEST" | grep -Eq '^sayknow-v[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "Release tag is not canonical: $LATEST"
        echo "For branch/commit installs, use --source with --ref."
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    acquire_install_lock
    # Download binary to a temp file first so a failed or partial download
    # never clobbers an existing working install at ${INSTALL_DIR}/skc.
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    DOWNLOAD_TMP=$(mktemp "${INSTALL_DIR}/.skc.download.XXXXXX")
    echo "Downloading ${BINARY}..."
    if ! curl -fsSL "$BINARY_URL" -o "$DOWNLOAD_TMP"; then
        rm -f "$DOWNLOAD_TMP"
        echo ""
        echo "No prebuilt SKC binary was found for ${PLATFORM}-${ARCH} in ${LATEST}."
        echo "Fallback options:"
        echo "  - Install via Bun/npm source package: bun install -g sayknow-cli"
        echo "  - Re-run this installer with --source to build/use the npm package path"
        echo "  - Choose a release that publishes ${BINARY}"
        echo "Expected asset URL: $BINARY_URL"
        exit 1
    fi
    verify_binary_checksum "$BINARY" "$DOWNLOAD_TMP"
    chmod +x "$DOWNLOAD_TMP"
    mv -f "$DOWNLOAD_TMP" "${INSTALL_DIR}/skc"
    DOWNLOAD_TMP=""
    echo ""
    echo "✓ Installed skc to ${INSTALL_DIR}/skc"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'skc' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'skc'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: use bun if available, otherwise binary
        if has_bun; then
            require_bun_version
            install_via_bun
        else
            install_binary
        fi
        ;;
esac
