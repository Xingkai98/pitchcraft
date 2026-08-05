#!/usr/bin/env python3
"""开发用静态服务器：所有响应加 no-cache 头，避免浏览器缓存 JS/HTML。
用法：python3 serve.py 8000"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

class ReuseServer(socketserver.TCPServer):
    allow_reuse_address = True

with ReuseServer(("0.0.0.0", PORT), NoCacheHandler) as httpd:
    print(f"Serving on 0.0.0.0:{PORT} (no-cache)")
    httpd.serve_forever()
