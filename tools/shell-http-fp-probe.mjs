// False-positive probe for the shell-HTTP block.
//
// Every case here is a command the model might legitimately write. The point of the file is
// that the URLs live in the FILE, not in the shell command line that runs it — because a
// shell command merely CONTAINING "http://" is exactly what the block refuses, which is the
// false positive under investigation (it refused this probe when it was inlined).
//
// Usage: node tools/shell-http-fp-probe.mjs
//
// It prints must-allow / must-block cases with the candidate that decided each one, so a
// regression names its own cause. `test/shell-http-block.test.js` pins the same shapes; this
// is the wider net to run before changing the block, because a policy change is judged by
// what it stops doing as much as by what it still stops.
import { blockShellHttp } from '../lib/block-policy.js'
import { unwrapCommands, extractUrls, firstVerb, isLocalHost, normUrl, FETCH_API } from '../lib/normalize.js'
import { DEFAULTS } from '../lib/defaults.js'

const SCHEME = 'ht' + 'tp'          // keep the literal out of reach of a shell that blocks on sight
const U = (rest) => SCHEME + '://' + rest
const REMOTE = U('example.com')
const LOCAL = U('192.168.111.101:18090/v1/models')

const cases = [
  ['explanatory JSON on stdout', `echo '{"note":"see ${REMOTE} for docs"}'`],
  ['JSON written to a file', `printf '{"url":"${LOCAL}"}' > /tmp/x.json`],
  ['python printing JSON', `python3 -c "import json; print(json.dumps({'endpoint':'${REMOTE}'}))"`],
  ['heredoc JSON', `cat <<EOF\n{"docs":"${REMOTE}"}\nEOF`],
  ['comment mentioning a URL', `# see ${REMOTE} for the API shape\necho done`],
  ['grep for a URL in a file', `grep -n '${REMOTE}' notes.md`],
  // The shapes a JSON blob takes when it is not all on one line — the reported case.
  ['multiline JSON, bare URL line', `cat <<EOF\n{\n"a": "x",\n${REMOTE}\n}\nEOF`],
  ['JSON array of URLs', `cat <<EOF\n[\n"${REMOTE}/a",\n"${REMOTE}/b"\n]\nEOF`],
  ['JSON pair starting with a URL', `cat <<EOF\n{\n${REMOTE} : "endpoint"\n}\nEOF`],
  ['YAML list of endpoints', `cat > e.yaml <<EOF\nendpoints:\n- ${REMOTE}/a\n- ${LOCAL}\nEOF`],
  ['node -e that only prints it', `node -e "console.log(process.argv[1])" ${REMOTE}`],
  // The shape the neighbour reported: the URL sits IMMEDIATELY after a colon inside JSON, so
  // the split leaves a candidate that STARTS with the scheme.
  ['JSON: colon then URL', `echo '{"note":"${REMOTE}"}'`],
  ['JSON: url key, no space', `echo '{"url":"${REMOTE}"}'`],
  ['JSON: local URL after colon', `echo '{"endpoint":"${LOCAL}"}'`],
  ['JSON: url key then path', `echo '{"api":"${REMOTE}/v1/models"}'`],
  // The reported "even an explanatory JSON is blocked" case, pinned down: the block fires on
  // a segment whose FIRST TOKEN is the bare word `http`, which data can easily produce.
  ['[must allow] json scheme value http', `echo '{"scheme":"http","host":"smg"}'`],
  ['[must allow] json key named http', `echo '{"http":{"port":3080}}'`],
  ['[must allow] json array of schemes', `echo '["http","https"]'`],
  ['[must allow] yaml scheme http', `printf 'scheme: http\\nhost: smg\\n' > c.yaml`],
  ['[must allow] the word http alone', `echo http`],
  ['[must allow] write-out format string', `curl -s ${LOCAL} -w "HTTP %{http_code}\\n"`],
  ['[must allow] import without calling', `python3 - <<PY\nimport json, urllib.request\nprint("nothing is fetched here")\nPY`],
  ['[must allow] local python request', `python3 -c "import urllib.request; urllib.request.urlopen('${LOCAL}')"`],
  ['[must block] httpie (the real CLI)', `httpie GET ${REMOTE}/`],
  ['write-out format string', `curl -s ${LOCAL} -w "HTTP %{http_code}\\n"`],
  ['import without calling it', `python3 - <<PY\nimport json, urllib.request\nprint("nothing is fetched here")\nPY`],
  ['local python request', `python3 -c "import urllib.request; urllib.request.urlopen('${LOCAL}')"`],
  // ---- the cases that MUST keep blocking ----
  ['[must block] remote curl', `curl -s ${REMOTE}/`],
  ['[must block] remote wget', `wget -q -O- ${REMOTE}/`],
  ['[must block] remote python', `python3 -c "import urllib.request; urllib.request.urlopen('${REMOTE}')"`],
  ['[must block] remote httpx', `python3 -c "import httpx; httpx.get('${REMOTE}')"`],
  ['[must block] remote node fetch', `node -e "fetch('${REMOTE}').then(r=>r.text())"`],
  ['[must allow] local curl', `curl -s ${LOCAL}`],
  ['[must allow] plain work', `ls -la /tmp && grep -n todo README.md`],
]

function explain(command) {
  for (const cand of unwrapCommands(command)) {
    const verb = firstVerb(cand)
    const named = verb.length > 0 && DEFAULTS.shellHttpBlock.includes(verb)
    const api = FETCH_API.test(cand)
    if (!named && !api) continue
    const urls = extractUrls(cand).map((raw) => normUrl(raw, {})).filter(Boolean)
    const localOnly = urls.length > 0 && urls.every((url) => isLocalHost(url.host))
    if (localOnly && DEFAULTS.blockLocalHttp !== true) continue
    return (named ? `verb=${verb}` : 'FETCH_API') + ` urls=${urls.length} :: ${JSON.stringify(cand.slice(0, 56))}`
  }
  return ''
}

let wrong = 0
for (const [name, command] of cases) {
  const blocked = blockShellHttp(command, DEFAULTS)
  const must = name.startsWith('[must block]') ? true : name.startsWith('[must allow]') ? false : null
  const verdict = must === null ? '' : blocked === must ? '  OK' : '  <<< WRONG'
  if (must !== null && blocked !== must) wrong += 1
  console.log(`${blocked ? 'BLOCK' : 'allow'}  ${name.padEnd(30)}${explain(command) ? ' <- ' + explain(command) : ''}${verdict}`)
}
const mustBlock = cases.filter(([n]) => n.startsWith('[must block]'))
const mustAllow = cases.filter(([n]) => n.startsWith('[must allow]'))
console.log(`\nmust-block cases: ${mustBlock.length - mustBlock.filter(([, c]) => blockShellHttp(c, DEFAULTS)).length} missed`)
console.log(`must-allow cases: ${mustAllow.length - mustAllow.filter(([, c]) => !blockShellHttp(c, DEFAULTS)).length} wrongly blocked`)
console.log(`total disagreements with the expectations: ${wrong}`)
