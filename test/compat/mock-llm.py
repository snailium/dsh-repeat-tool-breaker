#!/usr/bin/env python3
"""Scripted OpenAI-compatible model, so a REAL dsh boot can be driven with no GPU.

It emits the same `bash` tool call over and over (until it has seen MOCK_REPEATS
tool results, default 4), then finishes. Combined with the breaker's cap, the
trajectory of a healthy run is: attempts 1..cap-1 executed, attempts cap.. denied.

Used by run-compat.sh; see that file for the whole procedure.

Usage:
    MOCK_REPEATS=4 python3 mock-llm.py [port]
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get('MOCK_MODEL', 'mock-model')
COMMAND = os.environ.get('MOCK_COMMAND', 'echo compat-check')
REPEATS = int(os.environ.get('MOCK_REPEATS', '4'))


def frames(tool_results: int):
    """One assistant turn's SSE frames: the identical call, or the final answer."""
    base = {'id': 'chatcmpl-mock', 'object': 'chat.completion.chunk', 'created': 0, 'model': MODEL}

    def frame(delta, finish=None):
        return {**base, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}

    if tool_results < REPEATS:
        yield frame({'role': 'assistant', 'content': ''})
        yield frame({
            'tool_calls': [{
                'index': 0,
                'id': f'call_{tool_results + 1}',
                'type': 'function',
                'function': {
                    'name': 'bash',
                    'arguments': json.dumps({'command': COMMAND, 'description': 'compat check'}),
                },
            }],
        })
        yield frame({}, 'tool_calls')
    else:
        yield frame({'role': 'assistant', 'content': ''})
        yield frame({'content': 'compat run complete'})
        yield frame({}, 'stop')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def _json(self, body: bytes):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/v1/models'):
            self._json(json.dumps({'object': 'list', 'data': [{'id': MODEL, 'object': 'model'}]}).encode())
            return
        self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        payload = json.loads(self.rfile.read(length) or b'{}')
        tool_results = sum(1 for m in payload.get('messages') or [] if m.get('role') == 'tool')
        sys.stderr.write(f'[mock] {len(payload.get("messages") or [])} messages, {tool_results} tool results\n')
        sys.stderr.flush()

        if not payload.get('stream', False):
            self._json(json.dumps({
                'id': 'chatcmpl-mock', 'object': 'chat.completion', 'created': 0, 'model': MODEL,
                'choices': [{'index': 0, 'finish_reason': 'stop',
                             'message': {'role': 'assistant', 'content': 'compat run complete'}}],
                'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
            }).encode())
            return

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        def raw(data: bytes):
            self.wfile.write(b'%x\r\n' % len(data) + data + b'\r\n')
            self.wfile.flush()

        for frame in frames(tool_results):
            raw(f'data: {json.dumps(frame)}\n\n'.encode())
        raw(b'data: [DONE]\n\n')
        raw(b'')


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 18999), Handler).serve_forever()
