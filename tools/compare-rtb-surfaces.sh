#!/usr/bin/env bash
# Compare the surfaces dsh-repeat-tool-breaker actually keys on, between two installed dsh lines.
#
#   compare-rtb-surfaces.sh <old-prefix> <new-prefix>
#
# The sibling skill (dsh-0-2-migration) does this for the compaction/preset plugin. This is the
# same method applied to a different plugin's surfaces: file identity first, then the invariants
# and the error strings, because release notes do not mention the things that break a plugin.
set -uo pipefail
A="${1:?old prefix}/node_modules/@deepseek-ai"
B="${2:?new prefix}/node_modules/@deepseek-ai"

echo "== files this plugin patches, reads, or depends on for behaviour =="
for rel in \
  dsh-settings/lib/index.js \
  dsh-config-editor/lib/index.js \
  dsh-tools/lib/index.js \
  dsh-web/lib/index.js \
  dsh-web-fetch-http/lib/index.js \
  dsh-session/lib/index.js \
  dsh-api-settings-controller/lib/index.js \
  dsh-app-boot/lib/index.js \
  dsh-token-meter/lib/index.js \
  dsh-client-ui-primitives/lib/index.js \
  dsh-client-ui-plugin-manager/lib/client.js \
  dsh-client-ui-settings/lib/client.js \
  dsh-base/cordis.patch.yml \
  dsh-web-app/cordis.patch.yml
do
  if [ ! -f "$A/$rel" ] || [ ! -f "$B/$rel" ]; then printf '  %-52s missing on one side\n' "$rel"; continue; fi
  if cmp -s "$A/$rel" "$B/$rel"; then printf '  %-52s IDENTICAL\n' "$rel"
  else
    p=$(diff "$A/$rel" "$B/$rel" | grep -c '^>'); m=$(diff "$A/$rel" "$B/$rel" | grep -c '^<')
    printf '  %-52s DIFFERS (+%s/-%s)\n' "$rel" "$p" "$m"
  fi
done

echo
echo "== invariants =="

# Note: the marker is declared with an explicit version and checked on every write.
fmt_a=$(grep -ohE 'SESSION_FORMAT_VERSION = [0-9]+' "$A/dsh-session/lib/index.js" | head -1)
fmt_b=$(grep -ohE 'SESSION_FORMAT_VERSION = [0-9]+' "$B/dsh-session/lib/index.js" | head -1)
printf '  %-40s old=%-24s new=%s\n' 'session format' "$fmt_a" "$fmt_b"

for sym in volatileForm projectForm 'entry.fiber.runtime.Config' 'op: "unset"' 'expectedRevision' writable revision describe; do
  o=$(grep -c -- "$sym" "$A/dsh-settings/lib/index.js" 2>/dev/null)
  n=$(grep -c -- "$sym" "$B/dsh-settings/lib/index.js" 2>/dev/null)
  printf '  %-40s old=%-4s new=%s\n' "dsh-settings: $sym" "$o" "$n"
done

for sym in 'set' 'unset' 'path' 'revision' 'mutate' 'rejected' 'writable'; do
  o=$(grep -c -- "\"$sym\"" "$A/dsh-api-settings-controller/lib/index.js" 2>/dev/null)
  n=$(grep -c -- "\"$sym\"" "$B/dsh-api-settings-controller/lib/index.js" 2>/dev/null)
  printf '  %-40s old=%-4s new=%s\n' "settings-controller: \"$sym\"" "$o" "$n"
done

for sym in guard 'post-execute' additionalContexts; do
  o=$(grep -c -- "$sym" "$A/dsh-tools/lib/index.js" 2>/dev/null)
  n=$(grep -c -- "$sym" "$B/dsh-tools/lib/index.js" 2>/dev/null)
  printf '  %-40s old=%-4s new=%s\n' "dsh-tools: $sym" "$o" "$n"
done

o=$(grep -c 'redirect: "manual"' "$A/dsh-web-fetch-http/lib/index.js" 2>/dev/null)
n=$(grep -c 'redirect: "manual"' "$B/dsh-web-fetch-http/lib/index.js" 2>/dev/null)
printf '  %-40s old=%-4s new=%s\n' 'web-fetch-http: manual redirects' "$o" "$n"
o=$(grep -c 'validateFetchUrl' "$A/dsh-web-fetch-http/lib/index.js" 2>/dev/null)
n=$(grep -c 'validateFetchUrl' "$B/dsh-web-fetch-http/lib/index.js" 2>/dev/null)
printf '  %-40s old=%-4s new=%s\n' 'web-fetch-http: SSRF validation' "$o" "$n"

o=$(grep -c -- 'unwrapExports' "$A/cordis-plugin-loader/lib/index.js" 2>/dev/null)
n=$(grep -c -- 'unwrapExports' "$B/cordis-plugin-loader/lib/index.js" 2>/dev/null)
printf '  %-40s old=%-4s new=%s\n' 'loader: unwrapExports' "$o" "$n"

o=$(grep -c -- 'plugins.item' "$A/dsh-client-ui-plugin-manager/lib/client.js" 2>/dev/null)
n=$(grep -c -- 'plugins.item' "$B/dsh-client-ui-plugin-manager/lib/client.js" 2>/dev/null)
printf '  %-40s old=%-4s new=%s\n' 'client: plugins.item slot' "$o" "$n"

echo
echo "== error strings that define behaviour =="
for str in \
  "format v4 message requires a producer-owned source kind" \
  "cross-origin redirect to" \
  "is not followed automatically" \
  "must have plugin source" \
  "these values" \
  "rejected"
do
  o=$(grep -rl --include='*.js' -- "$str" "$A" 2>/dev/null | wc -l)
  n=$(grep -rl --include='*.js' -- "$str" "$B" 2>/dev/null | wc -l)
  printf '  %-56s old=%-4s new=%-4s %s\n' "$str" "$o" "$n" "$([ "$n" -gt 0 ] && echo ok || echo 'GONE -> re-read that path')"
done
