#!/usr/bin/env bash
# Bloomy — optimize-images.sh (replaces resize-images.sh)
#
# Converts the JPG and PNG images of ONE folder to WebP, with settings that suit
# a website: quality 80, metadata stripped, longest side capped at 1200 px
# (shrink only, never enlarge). WebP is usually 25-35% smaller than JPEG at the
# same visual quality, and keeps PNG transparency.
#
# Safe by design:
#   - shows a table of what it will do and asks "Proceed? [y/N]" (default No)
#   - leaves exceptions alone (og-image, favicon, logos ... because social
#     crawlers and browsers still expect JPG/PNG there) and asks for more
#   - skips images whose longest side is under --min px (icons, tiny thumbs)
#   - copies every original to ~/Pictures/original-image-backups/ and checks the
#     copy BEFORE changing anything
#   - keeps the original if the WebP turns out not to be smaller
#   - at the end lists files in your repo that still mention the old names,
#     because changing an extension silently breaks every reference to it
#
# Usage:   ./optimize-images.sh [options] [FOLDER]      (FOLDER defaults to .)
#
# Run it from your repo root:   ./optimize-images.sh public/images

set -euo pipefail

# ---------- defaults ----------
MAX=1200            # longest side after conversion, in px
QUALITY=80          # WebP quality 1-100 (lossy)
MIN=200             # skip images whose longest side is below this, in px
LOSSLESS=0
KEEP=0
YES=0
DRY=0
RECURSIVE=0
BACKUP_ROOT="$HOME/Pictures/original-image-backups"
BUILTIN_EXC=('og-image.*' 'favicon*' '*logo*' 'apple-touch-icon*')
USER_EXC=()
DIR="."

usage() {
  cat <<EOF
optimize-images.sh — convert JPG/PNG images to WebP (backup, confirmation, exceptions)

Usage: $(basename "$0") [options] [FOLDER]

  FOLDER                 folder to process (default: current folder, not its subfolders)

Options:
  --max N                longest side in px after conversion, shrink only   (default $MAX)
  --quality N            WebP quality 1-100                                 (default $QUALITY)
  --lossless             lossless WebP (much bigger; for pixel-perfect art)
  --min N                skip images whose longest side is below N px       (default $MIN)
  --exclude PATTERN      leave files matching PATTERN alone (glob on the file name,
                         repeatable), e.g. --exclude 'hero-*'
  --backup-dir DIR       where backups go   (default $BACKUP_ROOT)
  -r, --recursive        include subfolders
  -n, --dry-run          show the table and stop; changes nothing
  -y, --yes              no questions (needed when not running in a terminal)
  --keep                 keep the original files in the folder after converting
  -h, --help             this text

Always left alone unless you change the code: ${BUILTIN_EXC[*]}

Examples:
  $(basename "$0") --dry-run public/images
  $(basename "$0") public/images
  $(basename "$0") --max 900 --exclude 'hero-*' public/images
EOF
}

die() { echo "Error: $1" >&2; exit "${2:-2}"; }
need() { [ "$#" -ge 2 ] || die "$1 needs a value (try --help)"; }

# ---------- arguments ----------
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --max) need "$@"; MAX="$2"; shift 2 ;;
    --quality) need "$@"; QUALITY="$2"; shift 2 ;;
    --min) need "$@"; MIN="$2"; shift 2 ;;
    --exclude) need "$@"; USER_EXC+=("$2"); shift 2 ;;
    --backup-dir) need "$@"; BACKUP_ROOT="$2"; shift 2 ;;
    --lossless) LOSSLESS=1; shift ;;
    --keep) KEEP=1; shift ;;
    -r|--recursive) RECURSIVE=1; shift ;;
    -n|--dry-run) DRY=1; shift ;;
    -y|--yes) YES=1; shift ;;
    --) shift; break ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) DIR="$1"; shift ;;
  esac
done

[[ "$MAX" =~ ^[0-9]+$ && "$MAX" -ge 16 ]] || die "--max must be a number of at least 16"
[[ "$MIN" =~ ^[0-9]+$ ]] || die "--min must be a number"
[[ "$QUALITY" =~ ^[0-9]+$ && "$QUALITY" -ge 1 && "$QUALITY" -le 100 ]] || die "--quality must be 1-100"
[ -d "$DIR" ] || die "not a folder: $DIR"
DIR_ABS="$(cd "$DIR" && pwd)"

# ---------- ImageMagick with WebP support ----------
if command -v magick >/dev/null 2>&1; then
  IM_CONVERT=(magick); IM_IDENTIFY=(magick identify)
elif command -v convert >/dev/null 2>&1 && command -v identify >/dev/null 2>&1; then
  IM_CONVERT=(convert); IM_IDENTIFY=(identify)
else
  die "ImageMagick not found. Install it:  sudo apt install imagemagick webp"
fi
if ! "${IM_CONVERT[@]}" -list format 2>/dev/null | grep -qi '^ *WEBP'; then
  die "this ImageMagick has no WebP support. Try:  sudo apt install imagemagick webp libwebp-dev"
fi

# ---------- helpers ----------
bytes_of() { wc -c < "$1" | tr -d ' '; }
kb() { awk -v b="$1" 'BEGIN { printf "%.0f", b / 1024 }'; }
fmt_total() { awk -v b="$1" 'BEGIN { if (b >= 1048576) printf "%.1f MB", b / 1048576; else printf "%.0f KB", b / 1024 }'; }

CURRENT_TMP=""
cleanup() { [ -n "$CURRENT_TMP" ] && rm -f -- "$CURRENT_TMP" || true; }
trap cleanup EXIT

is_exception() {
  local name="$1" p
  shopt -s nocasematch
  for p in "${BUILTIN_EXC[@]}" ${USER_EXC[@]+"${USER_EXC[@]}"}; do
    # shellcheck disable=SC2053  # the pattern is meant to be a glob
    if [[ $name == $p ]]; then shopt -u nocasematch; return 0; fi
  done
  shopt -u nocasematch
  return 1
}

# ---------- scan ----------
F_PATH=(); F_NAME=(); F_W=(); F_H=(); F_BYTES=()
find_args=("$DIR_ABS")
[ "$RECURSIVE" -eq 0 ] && find_args+=(-maxdepth 1)
while IFS= read -r -d '' f; do
  w=0; h=0
  read -r w h < <("${IM_IDENTIFY[@]}" -format '%w %h' "${f}[0]" 2>/dev/null || true) || true
  w="${w:-0}"; h="${h:-0}"
  [[ "$w" =~ ^[0-9]+$ ]] || w=0
  [[ "$h" =~ ^[0-9]+$ ]] || h=0
  F_PATH+=("$f"); F_NAME+=("$(basename "$f")"); F_W+=("$w"); F_H+=("$h"); F_BYTES+=("$(bytes_of "$f")")
done < <(find "${find_args[@]}" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print0 | sort -z)

[ "${#F_PATH[@]}" -gt 0 ] || { echo "No JPG/PNG images found in $DIR_ABS. Nothing to do."; exit 0; }

# ---------- classify: convert / skip / exception ----------
F_ACTION=(); F_WHY=()
classify() {
  local i f target longest
  declare -A planned=()
  F_ACTION=(); F_WHY=()
  for i in "${!F_PATH[@]}"; do
    f="${F_PATH[$i]}"; target="${f%.*}.webp"
    if is_exception "${F_NAME[$i]}"; then
      F_ACTION[$i]="exception"; F_WHY[$i]="left alone (exception)"
    elif [ "${F_W[$i]}" -eq 0 ]; then
      F_ACTION[$i]="skip"; F_WHY[$i]="unreadable image"
    else
      longest=${F_W[$i]}; [ "${F_H[$i]}" -gt "$longest" ] && longest=${F_H[$i]}
      if [ "$longest" -lt "$MIN" ]; then
        F_ACTION[$i]="skip"; F_WHY[$i]="too small (${longest}px < ${MIN}px)"
      elif [ -e "$target" ]; then
        F_ACTION[$i]="skip"; F_WHY[$i]="$(basename "$target") already exists"
      elif [ -n "${planned[$target]:-}" ]; then
        F_ACTION[$i]="skip"; F_WHY[$i]="same name as another file being converted"
      else
        planned[$target]=1
        F_ACTION[$i]="convert"; F_WHY[$i]="-> $(basename "$target")"
      fi
    fi
  done
}

print_table() {
  local i n_conv=0 n_skip=0 n_exc=0 bytes_conv=0 label
  echo
  printf '%-42s %9s %11s  %s\n' "FILE" "SIZE" "PIXELS" "ACTION"
  printf '%-42s %9s %11s  %s\n' "----" "----" "------" "------"
  for i in "${!F_PATH[@]}"; do
    label="${F_PATH[$i]#"$DIR_ABS"/}"
    [ "${#label}" -gt 42 ] && label="...${label: -39}"
    case "${F_ACTION[$i]}" in
      convert)   label_action="CONVERT  ${F_WHY[$i]}"; n_conv=$((n_conv + 1)); bytes_conv=$((bytes_conv + F_BYTES[i])) ;;
      exception) label_action="leave    ${F_WHY[$i]}"; n_exc=$((n_exc + 1)) ;;
      *)         label_action="skip     ${F_WHY[$i]}"; n_skip=$((n_skip + 1)) ;;
    esac
    printf '%-42s %7s KB %5sx%-5s  %s\n' "$label" "$(kb "${F_BYTES[$i]}")" "${F_W[$i]}" "${F_H[$i]}" "$label_action"
  done
  echo
  echo "To convert: $n_conv ($(fmt_total "$bytes_conv"))   Skipped: $n_skip   Exceptions: $n_exc"
  N_CONV=$n_conv
}

echo "Folder:   $DIR_ABS$([ "$RECURSIVE" -eq 1 ] && echo ' (including subfolders)')"
if [ "$LOSSLESS" -eq 1 ]; then
  echo "Settings: lossless WebP, longest side max ${MAX}px (shrink only), skip images under ${MIN}px"
else
  echo "Settings: WebP quality ${QUALITY}, longest side max ${MAX}px (shrink only), skip images under ${MIN}px"
fi
echo "Always left alone: ${BUILTIN_EXC[*]}${USER_EXC[*]:+ $(printf '%s ' "${USER_EXC[@]}")}"

# ---------- ask for extra exceptions ----------
if [ "$YES" -eq 0 ] && [ "$DRY" -eq 0 ]; then
  [ -t 0 ] || die "not running in a terminal: add --yes to proceed without questions, or --dry-run to only look" 1
  echo
  echo "Anything else to leave alone? File names or globs separated by spaces"
  echo "(for example: hero-bouquet.jpg category-*). Press Enter for none."
  read -r -p "Exceptions: " extra_line || extra_line=""
  if [ -n "${extra_line// }" ]; then
    read -r -a extra_arr <<< "$extra_line"
    USER_EXC+=("${extra_arr[@]}")
  fi
fi

classify
print_table

if [ "$N_CONV" -eq 0 ]; then
  echo "Nothing to convert."
  exit 0
fi
if [ "$DRY" -eq 1 ]; then
  echo "Dry run: nothing was changed."
  exit 0
fi

BACKUP_DIR="$BACKUP_ROOT/$(basename "$DIR_ABS")-$(date +%Y%m%d-%H%M%S)"
echo "Backup:   originals will be copied to $BACKUP_DIR"
if [ "$KEEP" -eq 1 ]; then
  echo "          (originals also stay in the folder, because of --keep)"
else
  echo "          (originals are removed from the folder after a successful conversion)"
fi

if [ "$YES" -eq 0 ]; then
  read -r -p "Proceed? [y/N] " answer || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) echo "Aborted. Nothing was changed."; exit 1 ;;
  esac
fi

# ---------- backup, verified before anything is touched ----------
mkdir -p "$BACKUP_DIR"
for i in "${!F_PATH[@]}"; do
  [ "${F_ACTION[$i]}" = "convert" ] || continue
  rel="${F_PATH[$i]#"$DIR_ABS"/}"
  mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  cp -p -- "${F_PATH[$i]}" "$BACKUP_DIR/$rel"
  cmp -s -- "${F_PATH[$i]}" "$BACKUP_DIR/$rel" || die "backup of $rel does not match the original; nothing was changed" 1
done
echo "Backup verified ($N_CONV files)."
echo

# ---------- convert ----------
im_args=(-auto-orient -strip -resize "${MAX}x${MAX}>")
if [ "$LOSSLESS" -eq 1 ]; then
  im_args+=(-define webp:lossless=true)
else
  im_args+=(-quality "$QUALITY")
fi
im_args+=(-define webp:method=6)

n_done=0; n_kept=0; n_fail=0; n_seen=0
total_before=0; total_after=0
REMOVED_NAMES=()
for i in "${!F_PATH[@]}"; do
  [ "${F_ACTION[$i]}" = "convert" ] || continue
  n_seen=$((n_seen + 1))
  f="${F_PATH[$i]}"; target="${f%.*}.webp"; CURRENT_TMP="${target%.webp}.tmp-optimize.webp"
  before=${F_BYTES[$i]}
  if ! "${IM_CONVERT[@]}" "${f}[0]" "${im_args[@]}" "$CURRENT_TMP" 2>/dev/null \
     || [ ! -s "$CURRENT_TMP" ] \
     || ! "${IM_IDENTIFY[@]}" "$CURRENT_TMP" >/dev/null 2>&1; then
    printf '  [%d/%d] %s: FAILED, original left untouched\n' "$n_seen" "$N_CONV" "${F_NAME[$i]}"
    rm -f -- "$CURRENT_TMP"; CURRENT_TMP=""; n_fail=$((n_fail + 1)); continue
  fi
  after=$(bytes_of "$CURRENT_TMP")
  if [ "$after" -ge "$before" ]; then
    printf '  [%d/%d] %s: WebP not smaller (%s KB vs %s KB), original kept\n' "$n_seen" "$N_CONV" "${F_NAME[$i]}" "$(kb "$after")" "$(kb "$before")"
    rm -f -- "$CURRENT_TMP"; CURRENT_TMP=""; n_kept=$((n_kept + 1)); continue
  fi
  mv -- "$CURRENT_TMP" "$target"; CURRENT_TMP=""
  printf '  [%d/%d] %s -> %s   %s KB -> %s KB\n' "$n_seen" "$N_CONV" "${F_NAME[$i]}" "$(basename "$target")" "$(kb "$before")" "$(kb "$after")"
  total_before=$((total_before + before)); total_after=$((total_after + after)); n_done=$((n_done + 1))
  if [ "$KEEP" -eq 0 ]; then
    rm -f -- "$f"; REMOVED_NAMES+=("${F_NAME[$i]}")
  fi
done

# ---------- summary ----------
echo
echo "Converted: $n_done   Original kept (WebP not smaller): $n_kept   Failed: $n_fail"
if [ "$n_done" -gt 0 ]; then
  echo "Size of converted files: $(fmt_total "$total_before") -> $(fmt_total "$total_after") (saved $(fmt_total $((total_before - total_after))))"
fi
echo "Backup: $BACKUP_DIR"

# ---------- who still points at the old names? ----------
if [ "${#REMOVED_NAMES[@]}" -gt 0 ]; then
  ROOT="$(git -C "$DIR_ABS" rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
  pat_file="$(mktemp)"
  printf '%s\n' "${REMOVED_NAMES[@]}" > "$pat_file"
  hits="$(grep -rIFwoH -f "$pat_file" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir="$(basename "$BACKUP_ROOT")" "$ROOT" 2>/dev/null | sort -u || true)"
  rm -f "$pat_file"
  echo
  if [ -n "$hits" ]; then
    echo "These files still mention the OLD file names and need the new .webp names"
    echo "(nothing was edited for you):"
    echo "$hits" | awk -F: '{ f=$1; n=$NF; c[f]++; l[f]=l[f] (c[f] <= 4 ? " " n : "") }
      END { for (f in c) printf "  %s  (%d name%s:%s%s)\n", f, c[f], (c[f] == 1 ? "" : "s"), l[f], (c[f] > 4 ? " ..." : "") }' | sort
  else
    echo "No file in $ROOT mentions the old names."
  fi
  echo
  echo "Not checked: database rows. If products.image or product_images.image hold these"
  echo "names, update them, e.g.:  UPDATE products SET image = regexp_replace(image, '\\.(jpe?g|png)\$', '.webp');"
fi

[ "$n_fail" -eq 0 ] || exit 1
