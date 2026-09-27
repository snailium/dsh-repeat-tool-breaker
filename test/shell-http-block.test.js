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
