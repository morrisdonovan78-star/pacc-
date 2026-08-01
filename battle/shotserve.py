# Serves _karttest AND accepts POST /shot <binary> -> writes _karttest/shot.png.
#
# Why: the hero art for the homepage card must be a REAL frame of the real game, not a hand-drawn
# imitation of one. The only way to get the canvas out of the browser pane and onto disk is to let the
# page POST it somewhere, so this is that somewhere. Read-only otherwise; localhost only.
import http.server, os, socketserver

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'devroot')

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        if not self.path.startswith('/shot'):
            self.send_response(404); self._cors(); self.end_headers(); return
        name = self.path.split('?', 1)[1] if '?' in self.path else 'shot.png'
        name = os.path.basename(name) or 'shot.png'
        n = int(self.headers.get('Content-Length') or 0)
        data = self.rfile.read(n)
        with open(os.path.join(ROOT, name), 'wb') as f:
            f.write(data)
        self.send_response(200); self._cors()
        self.send_header('Content-Type', 'text/plain'); self.end_headers()
        self.wfile.write(('wrote %s %d bytes' % (name, len(data))).encode())
        print('wrote', name, len(data), 'bytes', flush=True)

    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 8790), H) as s:
    print('shotserve on http://127.0.0.1:8789', flush=True)
    s.serve_forever()
