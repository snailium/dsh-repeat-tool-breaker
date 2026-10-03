export const en = {
  title: 'Repeat tool breaker',
  description: 'Interrupts a stuck turn: repeats of the same call, and runs of consecutive failures.',
  collapse: 'Collapse',
  expand: 'Expand',
  unsaved: 'Unsaved',
  unavailable: 'These settings are unavailable in this deployment.',
  readOnly: 'This deployment serves these settings read-only.',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidNumber: 'A whole number is required.',
  save: 'Save',
  saving: 'Saving\u2026',
  discard: 'Discard',
  saveFailed: 'The Host refused part of the change. Drafts were kept; check the logs.',

  blockShellHttp: 'Block HTTP from the shell',
  blockShellHttpHint:
    'Refuse a shell command that fetches over HTTP and send the model to web_fetch_file instead.',
  blockLocalHttp: 'Also block local fetches',
  blockLocalHttpHint:
    'Extend the block to loopback and private addresses. Off: a local fetch is ordinary work, and web_fetch_file reaches local addresses too when "Fetch with curl" is on.',
  fetchWithCurl: 'Fetch with curl (risk)',
  fetchWithCurlHint:
    'ON by default. RISK: curl saves ANY content type (PDF, image, archive), follows redirects off-origin, shares cookies between fetches of one session, and reaches anything the shell can reach — loopback and RFC1918 included. Turn OFF to fetch through the platform web service instead: text pages only, no cross-origin redirects, and no private addresses.',
  shellHttpBlock: 'Commands to refuse',
  shellHttpBlockHint:
    'Comma-separated commands the block refuses, such as curl and wget. An interpreter program naming a request API is refused too.',
  warnAt: 'Advisory threshold',
  warnAtHint: 'Repeats of one call before the light advisory that says to change approach.',
  summarizeAt: 'Summary threshold',
  summarizeAtHint: 'Repeats before the call is asked to summarize its progress first.',
  failWarnAt: 'Failure advisory threshold',
  failWarnAtHint: 'Consecutive failures before the advisory that says to stop retrying.',
  failLimit: 'Failure block threshold',
  failLimitHint: 'Consecutive failures before the call is refused outright.',
}

export const zh = {
  title: '\u91cd\u590d\u5de5\u5177\u65ad\u8def\u5668',
  description:
    '\u4e2d\u65ad\u5361\u4f4f\u7684\u56de\u5408\uff1a\u540c\u4e00\u8c03\u7528\u7684\u91cd\u590d\uff0c\u4ee5\u53ca\u8fde\u7eed\u5931\u8d25\u3002',
  collapse: '\u6536\u8d77',
  expand: '\u5c55\u5f00',
  unsaved: '\u672a\u4fdd\u5b58',
  unavailable: '\u672c\u90e8\u7f72\u4e2d\u8fd9\u4e9b\u8bbe\u7f6e\u4e0d\u53ef\u7528\u3002',
  readOnly: '\u672c\u90e8\u7f72\u4ee5\u53ea\u8bfb\u65b9\u5f0f\u63d0\u4f9b\u8fd9\u4e9b\u8bbe\u7f6e\u3002',
  overridden: '\u5df2\u8986\u76d6',
  reset: '\u91cd\u7f6e',
  invalidNumber: '\u9700\u8981\u4e00\u4e2a\u6574\u6570\u3002',
  save: '\u4fdd\u5b58',
  saving: '\u4fdd\u5b58\u4e2d\u2026',
  discard: '\u653e\u5f03',
  saveFailed:
    '\u4e3b\u673a\u62d2\u7edd\u4e86\u90e8\u5206\u4fee\u6539\u3002\u8349\u7a3f\u5df2\u4fdd\u7559\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002',

  blockShellHttp: '\u62e6\u622a shell \u4e2d\u7684 HTTP',
  blockShellHttpHint:
    '\u62d2\u7edd\u4efb\u4f55\u5728 shell \u91cc\u53d1\u8d77 HTTP \u6293\u53d6\u7684\u547d\u4ee4\uff0c\u6539\u7528 web_fetch_file\u3002',
  blockLocalHttp: '\u540c\u65f6\u62e6\u622a\u672c\u5730\u6293\u53d6',
  blockLocalHttpHint:
    '\u5c06\u62e6\u622a\u6269\u5c55\u5230\u56de\u73af\u4e0e\u5185\u7f51\u5730\u5740\u3002\u9ed8\u8ba4\u5173\u95ed\uff1a\u672c\u5730\u6293\u53d6\u662f\u5e38\u89c1\u5de5\u4f5c\uff0c\u800c\u4e14\u5f00\u542f\u201c\u7528 curl \u6293\u53d6\u201d\u540e web_fetch_file \u4e5f\u80fd\u5230\u8fbe\u672c\u5730\u5730\u5740\u3002',
  fetchWithCurl: '\u7528 curl \u6293\u53d6\uff08\u98ce\u9669\uff09',
  fetchWithCurlHint:
    '\u9ed8\u8ba4\u5f00\u542f\u3002\u98ce\u9669\uff1acurl \u4f1a\u4fdd\u5b58\u4efb\u610f\u7c7b\u578b\uff08PDF\u3001\u56fe\u7247\u3001\u538b\u7f29\u5305\uff09\u3001\u8ddf\u968f\u8de8\u6e90\u91cd\u5b9a\u5411\u3001\u5728\u540c\u4e00 session \u5185\u5171\u4eab cookie\uff0c\u5e76\u4e14\u80fd\u8bbf\u95ee shell \u80fd\u8bbf\u95ee\u7684\u4e00\u5207\u2014\u2014\u5305\u62ec\u56de\u73af\u4e0e\u5185\u7f51\u5730\u5740\u3002\u5173\u95ed\u540e\u6539\u8d70\u5e73\u53f0 web \u670d\u52a1\uff1a\u53ea\u80fd\u53d6\u6587\u672c\u9875\u3001\u4e0d\u8ddf\u8de8\u6e90\u91cd\u5b9a\u5411\u3001\u4e0d\u80fd\u89e6\u53ca\u79c1\u6709\u5730\u5740\u3002',
  shellHttpBlock: '\u8981\u62d2\u7edd\u7684\u547d\u4ee4',
  shellHttpBlockHint:
    '\u9017\u53f7\u5206\u9694\u3002\u5217\u5728\u8fd9\u91cc\u7684\u547d\u4ee4\u4f1a\u88ab\u62d2\u7edd\uff0c\u5982 curl \u4e0e wget\uff1b\u89e3\u91ca\u5668\u7a0b\u5e8f\u91cc\u51fa\u73b0\u8bf7\u6c42 API \u4e5f\u4e00\u6837\u3002',
  warnAt: '\u63d0\u9192\u9608\u503c',
  warnAtHint: '\u540c\u4e00\u8c03\u7528\u91cd\u590d\u591a\u5c11\u6b21\u540e\uff0c\u8f7b\u5ea6\u63d0\u9192\u6362\u4e00\u6761\u8def\u3002',
  summarizeAt: '\u6c47\u603b\u9608\u503c',
  summarizeAtHint: '\u91cd\u590d\u591a\u5c11\u6b21\u540e\uff0c\u8981\u6c42\u5148\u6c47\u603b\u8fdb\u5c55\u3002',
  failWarnAt: '\u5931\u8d25\u63d0\u9192\u9608\u503c',
  failWarnAtHint:
    '\u8fde\u7eed\u5931\u8d25\u591a\u5c11\u6b21\u540e\uff0c\u63d0\u9192\u4e0d\u8981\u518d\u91cd\u8bd5\u3002',
  failLimit: '\u5931\u8d25\u963b\u65ad\u9608\u503c',
  failLimitHint: '\u8fde\u7eed\u5931\u8d25\u591a\u5c11\u6b21\u540e\uff0c\u76f4\u63a5\u62d2\u7edd\u8c03\u7528\u3002',
}
