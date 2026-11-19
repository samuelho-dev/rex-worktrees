import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import termios
import time


class Terminal:
    def __init__(self, scenario, log, binary, repo, env, rows, columns, normalize=True):
        self.scenario, self.log, self.normalize = scenario, log, normalize
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(binary, [binary, 'popup', '--context', repo], {**env, 'LUA_PATH': '', 'LUA_CPATH': ''})
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        self.data, self.offset = b'', 0

    def send(self, data):
        os.write(self.fd, data if isinstance(data, bytes) else data.encode())

    def read(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([self.fd], [], [], remaining)[0]:
            raise AssertionError(self.scenario + ' PTY timeout: ' + repr(self.data[-5000:]))
        try:
            chunk = os.read(self.fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO: return False
            raise
        previous = len(self.data)
        self.data += chunk
        start = max(0, previous - 3)
        for query in re.finditer(b'\x1b\\[(?:6n|0?c)', self.data[start:]):
            if start + query.end() > previous:
                self.send(b'\x1b[1;1R' if query.group() == b'\x1b[6n' else b'\x1b[?1;2c')
        return bool(chunk)

    def frame(self, *needles, absent=()):
        deadline = time.monotonic() + 20
        needles = [n.encode() if isinstance(n, str) else n for n in needles]
        while True:
            start = self.data.find(b'\x1b[H\x1b[2J', self.offset)
            if start >= 0:
                end = self.data.find(b'\x1b[0J', start)
                next_start = self.data.find(b'\x1b[H\x1b[2J', start + 1)
                if next_start >= 0 and (end < 0 or next_start < end):
                    self.offset = next_start
                    continue
                if end >= 0:
                    frame = self.data[start:end + 4]
                    self.offset = end + 4
                    text = frame.decode('utf-8')
                    match = b''.join(frame.split()) if self.normalize else frame
                    if all((b''.join(n.split()) if self.normalize else n) in match for n in needles) and not any(n.encode() in frame for n in absent):
                        return text
                    continue
            if not self.read(deadline):
                raise AssertionError(self.scenario + ' PTY closed: ' + repr(self.data[-5000:]))

    def requests(self, kind=None):
        try:
            with open(self.log) as log: rows = [json.loads(line) for line in log]
        except FileNotFoundError:
            rows = []
        return [row for row in rows if kind is None or row['kind'] == kind]

    def finish(self, success=True):
        deadline = time.monotonic() + 20
        while True:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if not pid:
                if self.read(deadline):
                    continue
                _, status = os.waitpid(self.pid, 0)
            self.pid = None
            assert os.WIFEXITED(status) and (os.WEXITSTATUS(status) == 0) == success, (self.scenario, status, self.data[-5000:])
            return

    def close(self):
        if self.pid:
            try: os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            os.waitpid(self.pid, 0)
            self.pid = None
        os.close(self.fd)
