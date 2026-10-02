// Regression tests for the shell-HTTP block's false positives.
//
// Every "allows" case below is a REAL refusal taken from session
// face7ffb-0f53-46a6-aa86-94a3b98346be (dsh 0.1.7), where four of 164 tool calls were
// stopped and all four were legitimate: three were python scripts talking to a LOCAL
// endpoint (192.168.111.101 is RFC1918) and one fetched nothing at all. The block is a
// steering mechanism, so a refusal costs a whole tool call — the reason to keep these
// pinned is that each of them was previously argued to be correct.
//
// The URL literals live in this file rather than on a command line on purpose: a shell
// command that merely CONTAINS a URL is itself refused, which is the same class of bug.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blockShellHttp } from '../lib/block-policy.js'
import { DEFAULTS } from '../lib/defaults.js'

const LOCAL = 'http://192.168.111.101:40114'
const LOCAL_MODELS = 'http://192.168.111.101:18090/v1/models'
const REMOTE = 'http://example.com'

/** The block is a refusal, so `true` here means "this call was stopped". */
const refused = (command, cfg = {}) => blockShellHttp(command, { ...DEFAULTS, ...cfg })

test('B1: the write-out format string is not a command', () => {
  // The real step 65. `curl` targets a LOCAL address and is correctly exempt; what tripped
  // the block was the candidate that starts with the format string's first word, whose only
  // content is `HTTP %{http_code}` — data, not a mechanism.
  const command = [
    'cd /tmp && curl -s --max-time 60 ' + LOCAL + '/v1/chat/completions \\',
    "  -H 'Content-Type: application/json' \\",
    '  -D /tmp/headers.txt \\',
    '  -w "HTTP %{http_code}\\n"',
  ].join('\n')
  assert.equal(refused(command), false, 'a local curl carrying a status write-out must run')
})

test('B2: importing a request module is not fetching', () => {
  // The real step 105: the script only prints a note. Its URL sits in the program text and
  // the request API is imported, but no request is made.
  const command = [
    'cd /repo && python3 - <<PY',
    'import json, urllib.request',
    'url = "' + LOCAL + '/v1/chat/completions"',
    'print("no call is made here")',
    'PY',
  ].join('\n')
  assert.equal(refused(command), false, 'a heredoc that fetches nothing must run')
})

test('B3: a python request to a LOCAL endpoint is not a remote fetch', () => {
  // The real steps 66 and 69. The split puts `import json, urllib.request` in one segment and
  // the address in another, so a per-segment local test can never see both.
  const urlopen = [
    'python3 - <<PY',
    'import json, urllib.request',
    'with urllib.request.urlopen("' + LOCAL + '/workers", timeout=30) as r:',
    '    d = json.load(r)',
    'PY',
  ].join('\n')
  assert.equal(refused(urlopen), false, 'a local endpoint must be reachable from the shell')

  const request = [
    'python3 - <<PY',
    'import json, urllib.request',
    'req = urllib.request.Request("' + LOCAL + '/v1/chat/completions", data=b"{}", method="POST")',
    'PY',
  ].join('\n')
  assert.equal(refused(request), false, 'same, via urllib.request.Request')
})

test('B4: a URL inside DATA is not a fetch, in any layout', () => {
  const layouts = [
    'echo \'{"note":"see ' + REMOTE + ' for docs"}\'',
    'echo \'{"note":"' + REMOTE + '"}\'',
    'echo \'{"api":"' + REMOTE + '/v1/models"}\'',
    'cat <<EOF\n{\n"a": "x",\n' + REMOTE + '\n}\nEOF',
    'cat <<EOF\n[\n"' + REMOTE + '/a",\n"' + REMOTE + '/b"\n]\nEOF',
    'printf \'{"url":"' + LOCAL_MODELS + '"}\' > /tmp/x.json',
    'grep -n \'' + REMOTE + '\' notes.md',
    '# see ' + REMOTE + ' for the API shape\necho done',
  ]
  for (const command of layouts) {
    assert.equal(refused(command), false, 'data carrying a URL must not be refused: ' + command.slice(0, 48))
  }
})

test('B5: the bare word for a scheme is not the HTTPie client', () => {
  // Why `http` left the default blacklist: as a first token it is far more often data than a
  // command, and a refusal there has no address to exempt it.
  for (const command of [
    'echo \'{"scheme":"http","host":"smg"}\'',
    'echo \'{"http":{"port":3080}}\'',
    'echo \'["http","https"]\'',
    'printf \'scheme: http\\nhost: smg\\n\' > c.yaml',
    'echo http',
  ]) {
    assert.equal(refused(command), false, 'the word alone must not be refused: ' + command)
  }
})

test('B6: a remote fetch is still refused, by every mechanism that can make one', () => {
  const mustRefuse = [
    'curl -s ' + REMOTE + '/',
    'wget -q -O- ' + REMOTE + '/',
    'httpie GET ' + REMOTE + '/',
    'python3 -c "import urllib.request; urllib.request.urlopen(\'' + REMOTE + '\')"',
    'python3 -c "import requests; requests.get(\'' + REMOTE + '\')"',
    'python3 -c "import httpx; httpx.get(\'' + REMOTE + '\')"',
    'node -e "fetch(\'' + REMOTE + '\').then(r=>r.text())"',
    'node -e "require(\'axios\').get(\'' + REMOTE + '\')"',
  ]
  for (const command of mustRefuse) {
    assert.equal(refused(command), true, 'a remote fetch must still be refused: ' + command)
  }
})

test('B7: a LOCAL fetch is still allowed, and blockLocalHttp still turns that off', () => {
  const local = ['curl -s ' + LOCAL_MODELS, 'python3 -c "import urllib.request; urllib.request.urlopen(\'' + LOCAL_MODELS + '\')"']
  for (const command of local) {
    assert.equal(refused(command), false, 'local stays exempt by default: ' + command)
    assert.equal(
      refused(command, { blockLocalHttp: true }),
      true,
      'blockLocalHttp: true must block the local case again — the exemption is a default, not a law',
    )
  }
})

test('B8: the blacklist is the block\'s off-switch', () => {
  assert.equal(
    refused('curl -s ' + REMOTE + '/', { shellHttpBlock: [] }),
    false,
    'an empty blacklist leaves only the request-API arm — the documented off-switch',
  )
  assert.equal(
    refused('curl -s ' + REMOTE + '/', { shellHttpBlock: ['curl'] }),
    true,
    'a shorter list still refuses what it names',
  )
  // A local command stays allowed even when the list names its verb, because the whole-command
  // local exemption is evaluated first — the exemption is a default, not something the list can
  // override. `blockLocalHttp: true` is how an operator overrides it (pinned in B7).
  assert.equal(refused('curl -s ' + LOCAL_MODELS, { shellHttpBlock: ['curl', 'wget'] }), false)
})

test('B9: a REMOTE payload is not this machine\'s fetch', () => {
  // Every shape below is a real refusal from session 12b8bd5b, where an agent was installing
  // software on a Steam Machine (192.168.111.142). `web_fetch_file` cannot run anything over
  // there, so judging these words refused remote administration and nothing else — including
  // "does the target even have curl?".
  const allowed = [
    "ssh -i key -o ConnectTimeout=15 deck@192.168.111.142 'command -v wget curl python3; echo ---; timeout 20 wget --version | head -1'",
    'ssh deck@192.168.111.142 \'ls /usr/bin/ | grep -iE "^(wget|curl|aria2c|python3)$"\'',
    "scp -i key /tmp/install.sh deck@host:/home/deck/install.sh && ssh deck@host 'command -v curl od sha256sum install stat'",
    // the model even obfuscated the word to get past the block, and was still refused
    'ssh deck@host \'printf "  %-10s " "curl"; command -v c""url >/dev/null 2>&1 && echo present\'',
    'ssh deck@host \'ls /usr/bin/ | grep -c "^curl$" | xargs -I{} echo "curl count: {}"\'',
    'rsync -a /src/ host:/dst/ && mosh host',
  ]
  for (const command of allowed) {
    assert.equal(refused(command), false, 'a remote payload must not be judged: ' + command.slice(0, 60))
  }

  // The payload is opaque, not the whole ssh line: a remote client is never itself a fetch.
  assert.equal(refused('ssh host'), false)

  // The costume the rule exists for: an `ssh` to THIS machine is a local fetch, so its payload
  // is judged exactly as if it had been typed locally. `localhost` and loopback cover the
  // reachable aliases; an address of a local interface is handled by `isThisMachineHost`.
  for (const command of [
    "ssh localhost 'curl -s " + REMOTE + "/x'",
    "ssh 127.0.0.1 'curl -s " + REMOTE + "/x'",
    "ssh -i key -o ConnectTimeout=5 127.0.0.1 'wget -q " + REMOTE + "/x'",
    "sshpass -p x ssh localhost 'curl -s " + REMOTE + "/x'",
    "mosh 127.0.0.1 'curl -s " + REMOTE + "/x'",
  ]) {
    assert.equal(refused(command), true, 'a payload that runs HERE must still be judged: ' + command)
  }

  // A target that cannot be resolved from the text is treated as elsewhere. This is the
  // project's standing trade: a false refusal costs a whole tool call, so an ambiguous host
  // (a variable or a command substitution) does not buy a refusal.
  assert.equal(refused("ssh $(hostname) 'curl -s " + REMOTE + "/x'"), false)
  assert.equal(refused("ssh $TARGET 'curl -s " + REMOTE + "/x'"), false)

  // …and a LOCAL shell still executes here, so a mechanism inside it is still a fetch.
  assert.equal(refused("bash -c 'wget -q " + REMOTE + "/x'"), true)
  assert.equal(refused("sudo curl -s " + REMOTE + '/x'), true)
})

test('B10: a name list, a quoted pattern and a bare word are data', () => {
  const allowed = [
    'command -v curl',
    'command -V wget',
    'which curl wget',
    'type curl',
    'grep -c "^curl$" /var/log/x',
    'curl',
    'wget',
  ]
  for (const command of allowed) {
    assert.equal(refused(command), false, 'not a command position: ' + command)
  }
  // `command` WITHOUT a lookup flag EXECUTES its argument — it must stay refused, or rule 2
  // would have opened a real hole.
  assert.equal(refused('command curl -s ' + REMOTE + '/x'), true)
  assert.equal(refused('command -p curl -s ' + REMOTE + '/x'), false, 'a flag the rule does not know is not a lookup')
})

test('B11: a heredoc written to a FILE is not run by this call', () => {
  // The real steps 18 and 25: a script authored locally, then shipped with `scp`. Refusing the
  // `cat` stopped nothing — the fetch happens when something else runs that file.
  const inert = [
    ["cat > /tmp/dl.sh <<'SCRIPT'", 'URL="' + REMOTE + '/v0.11.0/x"', 'curl -fL --max-time 120 -o "$DEST" "$URL" 2>&1 | tail -3', 'SCRIPT', 'scp /tmp/dl.sh deck@host:/home/deck/'].join('\n'),
    ['cat > /tmp/nettest.sh <<SCRIPT', 'echo "can the target reach the internet at all?"', 'python3 -c "import urllib.request; urllib.request.urlopen(\'' + REMOTE + '\')"', 'SCRIPT', 'ssh host "bash /tmp/nettest.sh"'].join('\n'),
  ]
  for (const command of inert) {
    assert.equal(refused(command), false, 'an inert heredoc must not be judged: ' + command.split('\n')[0])
  }

  // But a body handed to an INTERPRETER runs here, and is judged exactly as before.
  assert.equal(
    refused(['python3 - <<PY', 'import urllib.request', 'urllib.request.urlopen(' + JSON.stringify(REMOTE + '/x') + ')', 'PY'].join('\n')),
    true,
    'a heredoc fed to python still runs locally',
  )
  assert.equal(
    refused(['bash <<EOF', 'curl -s ' + REMOTE + '/x', 'EOF'].join('\n')),
    true,
    'a heredoc fed to a shell still runs locally',
  )
})

test('B12: a payload URL is data, and a target in a variable is still a target', () => {
  // Session 74d52304 (dsh 0.1.7). Three curls to the LOCAL dsh API — a verification run — and
  // two of them were refused. Two defects combined, and either one alone was harmless:
  //
  //   1. the address scan read a URL out of a JSON REQUEST BODY, so `{"publicOrigin":"https://…"}`
  //      made an all-local call look remote and defeated the whole-command exemption;
  //   2. the real target was `$B/remote/provider`, with `B=http://127.0.0.1:3080/api/mobile-access`
  //      assigned earlier in the same command, so the per-candidate exemption had nothing to test.
  const variableTarget = [
    'B=http://127.0.0.1:3080/api/mobile-access',
    'curl -s -m 12 -X POST -d \'{"publicOrigin":"https://' + 'public.example"}\' $B/remote/origin/configure',
  ].join('\n')
  assert.equal(refused(variableTarget), false, 'a local target held in a variable is still local')

  // The body's URL is DATA being configured, not a target being fetched.
  const bodyUrl = 'curl -s -X POST -d \'{"publicOrigin":"https://public.example"}\' ' + LOCAL + '/api/x'
  assert.equal(refused(bodyUrl), false, 'a URL inside a JSON body is not the target')
  const headerUrl = 'curl -s -H "origin: https://public.example" ' + LOCAL + '/api/x'
  assert.equal(refused(headerUrl), false, 'a URL inside a header value is not the target')
  const writeOut = 'curl -s -w "  http=%{http_code}\\n" -o /tmp/p.json ' + LOCAL + '/api/x'
  assert.equal(refused(writeOut), false, 'the write-out format is data, not a command')

  // …and the resolutions must not become a hole: a REMOTE target behind the same variable is
  // refused, because resolving the assignment is what makes it visible as remote.
  const remoteVariable = 'B=https://' + 'public.example/x\ncurl -s "$B"'
  assert.equal(refused(remoteVariable), true, 'a remote target behind a variable is still remote')

  // An interpreter's inline program is CODE, not data. `-c` is a cookie jar for a fetcher and
  // "execute this" for a shell; `-e` is a referer for a fetcher and "evaluate this" for node. A
  // verb-blind flag table deleted both programs and let these through — which is why the table is
  // applied per candidate, by verb (CODE_VERBS).
  assert.equal(refused("bash -c 'wget -q https://" + "public.example/x'"), true, 'an inline shell fetch is code')
  assert.equal(refused('node -e "fetch(\'https://' + 'public.example/x\')"'), true, 'an inline node fetch is code')
  assert.equal(refused('python3 -c "import urllib.request; urllib.request.urlopen(\'https://' + 'public.example/x\')"'), true)

  // An unresolvable target is still a refusal: "cannot prove it is local" is not "local".
  assert.equal(refused('curl -s "$UNSET_VARIABLE"'), true, 'an invisible target is not an exemption')
})

test('B13: the real refusals of session 74d52304 land on their documented verdict', async () => {
  const { readFileSync } = await import('node:fs')
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/session-74d52304-shell-http-refusals.json', import.meta.url), 'utf8'),
  )
  assert.ok(fixture.refusals.length >= 3, 'the fixture must carry the refusals it documents')
  // Two were false positives and one was RIGHT. Pinning only the first kind would invite a rule
  // that allows everything; the fixture carries each verdict and the reason, so a future retune
  // has to keep both directions true.
  for (const entry of fixture.refusals) {
    const want = entry.expect === 'refused'
    assert.equal(
      refused(entry.command),
      want,
      `turn ${entry.turn} step ${entry.step} should be ${entry.expect}: ${entry.verdict}`,
    )
  }
})
