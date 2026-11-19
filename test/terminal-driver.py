import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

root, binary, lua, repo, git_bin, jj_bin = sys.argv[1:]
os.makedirs(root + '/pty-bin', exist_ok=True)
env = os.environ.copy()
env.update(HOME=root, XDG_CONFIG_HOME=root+'/config', XDG_STATE_HOME=root+'/state',
           REX_BIN_DIR=root+'/pty-bin', REX_WORKTREES_LOCAL_ENDPOINT='unix:///fixture.sock',
           NO_COLOR='1', JJ_CONFIG=root+'/jj.toml',
           REX_WORKTREES_CONFIG=json.dumps({'directory':root,'config':{}}))
env['REX_PTY_LOG'] = root+'/pty-rex-log'
for key in ('REX_SESSION', 'REX_BLOCK', 'REX_CLIENT', 'REX_SERVER', 'REX_HOST'):
    env.pop(key, None)
rex = root + '/pty-bin/rex'
with open(rex, 'w') as f:
    f.write('''#!/bin/sh
for arg in "$@"; do last="$arg"; done
printf '%s\\n' "$last" >> "$REX_PTY_LOG"
if [ "$REX_TEST_PENDING" = 1 ]; then echo "$$" > "$HOME/pending-rex.pid"; exec tail -f /dev/null; fi
if [ "$REX_TEST_FAIL" = 1 ]; then echo "synthetic startup failure" >&2; exit 1; fi
case " $* " in
 *' hosts list '*) echo '{"home":{"label":"Local","endpoint":"unix:///fixture.sock","this_machine":true},"hosts":[]}' ;;
 *' whoami '*) echo '{"host_id":"fixture-host","endpoint":"unix:///fixture.sock","principal":{"transport":"unix"}}' ;;
 *' ls '*) if [ "$REX_DUP_SESSIONS" = 1 ]; then echo '{"sessions":[{"session_id":"first","label":"Same label"},{"session_id":"second","label":"Same label"}]}'; else echo '{"sessions":[{"session_id":"session","label":"Session"}]}'; fi ;;
 *' client.list '*) echo '{"clients":[]}' ;;
 *' session.list_blocks '*) if [ "$REX_TASK_MODE" = 1 ]; then echo '{"blocks":[{"block_id":"block","host_id":"fixture-host","placement":"placed","window_id":"window"}]}'; else echo '{"blocks":[]}'; fi ;;
 *' session.create '*) echo '{"session_id":"created","initial_windows":[{"window_id":"new-window","block_ids":["new-block"]}]}' ;;
 *' session.new_window '*) echo '{"window_id":"new-window","block_ids":["new-block"]}' ;;
 *' session.focus_block '*) echo '{}' ;;
 *) echo "unexpected rex call $*" >&2; exit 1 ;;
esac
''')
os.chmod(rex, 0o755)

def start(argv, env):
    pid, fd = pty.fork()
    if pid == 0:
        os.execve(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 96, 0, 0))
    return pid, fd

def frame(fd, needle, offset, buffer):
    deadline = time.monotonic() + 15
    while True:
        start_at = buffer.rfind(b'\x1b[H\x1b[2J', offset)
        if start_at >= offset:
            end = buffer.find(b'\x1b[0J', start_at)
            if end >= 0 and all(part in buffer[start_at:end] for part in (needle if isinstance(needle, tuple) else (needle,))):
                return buffer, end + 4
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise AssertionError('timeout waiting for frame '+repr(needle)+': '+repr(buffer[-1800:]))
        if select.select([fd], [], [], remaining)[0]:
            chunk = os.read(fd, 65536)
            if not chunk: raise AssertionError('PTY closed: '+repr(buffer[-1800:]))
            buffer += chunk

def finish(pid, fd, success=True):
    deadline = time.monotonic() + 15
    output = b''
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            os.close(fd)
            if not os.WIFEXITED(status) or (os.WEXITSTATUS(status) == 0) != success:
                raise AssertionError('PTY process failed: '+repr(output[-3000:]))
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); raise AssertionError('PTY timeout')
        if select.select([fd], [], [], remaining)[0]:
            try: output += os.read(fd, 65536)
            except OSError: pass

pending_env = env.copy()
pending_env['REX_TEST_PENDING'] = '1'
pid, fd = start([binary, 'popup', '--context', repo], pending_env)
try:
    data, at = frame(fd, b'Discovering', 0, b'')
    os.write(fd, b'\x13\x1b')
    finish(pid, fd)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise
finally:
    pidfile = root + '/pending-rex.pid'
    if os.path.exists(pidfile):
        with open(pidfile) as f: pending_pid = int(f.read())
        try: os.kill(pending_pid, signal.SIGKILL)
        except ProcessLookupError: pass

failure_env = env.copy()
failure_env['REX_TEST_FAIL'] = '1'
pid, fd = start([binary, 'popup', '--context', repo], failure_env)
try:
    data, at = frame(fd, b'synthetic startup failure', 0, b'')
    assert b'Could not open worktrees' in data
    os.write(fd, b'\r')
    finish(pid, fd, success=False)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise

pid, fd = start([binary, 'popup', '--context', repo], env)
try:
    data, at = frame(fd, (b'pty-source', b'Tab next'), 0, b'')
    os.write(fd, b'\r')
    data, at = frame(fd, b'Esc back', at, data)
    for byte in '木👩\u200d💻'.encode():
        os.write(fd, bytes([byte]))
    data, at = frame(fd, '木👩\u200d💻'.encode(), at, data)
    os.write(fd, b'\x7f')
    data, at = frame(fd, '木'.encode(), at, data)
    os.write(fd, b'\x1b')
    data, at = frame(fd, b'Tab next', at, data)
    os.write(fd, b'\r')
    data, at = frame(fd, b'Esc back', at, data)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 10, 60, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    data, at = frame(fd, b'Resize', at, data)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 22, 100, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    data, at = frame(fd, b'Esc back', at, data)
    os.write(fd, b'\x1b[B')
    data, at = frame(fd, b'Esc back', at, data)
    os.write(fd, b'\x13')
    data, at = frame(fd, b'Tab next', at, data)
    os.write(fd, b'\x1b')
    finish(pid, fd)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise
pid, fd = start([binary, 'popup', '--context', repo], env)
try:
    data, at = frame(fd, (b'pty-source', b'Session', b'Tab next'), 0, b'')
    os.write(fd, b'\x13')
    finish(pid, fd)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise
with open(env['REX_PTY_LOG']) as f:
    requests = []
    for line in f:
        try: requests.append(json.loads(line))
        except ValueError: pass
created = [item for item in requests if isinstance(item, dict) and 'window_label' in item and 'layout' in item]
assert len(created) == 1 and created[0]['session_id'] == 'session'
args = created[0]['layout']['block']['options']['command']
assert 'task' in args and json.loads(args[args.index('task')+1])['path'] == repo


pid, fd = start([binary, 'popup', '--context', repo], env)
try:
    data, at = frame(fd, (b'pty-source', b'Session', b'Tab next'), 0, b'')
    os.write(fd, b'\t\t\r')
    data, at = frame(fd, b'Esc back', at, data)
    os.write(fd, b'Session\r')
    data, at = frame(fd, (b'New: Session', b'Tab next'), at, data)
    os.write(fd, b'\x13')
    finish(pid, fd)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise
with open(env['REX_PTY_LOG']) as f:
    requests = []
    for line in f:
        try: requests.append(json.loads(line))
        except ValueError: pass
new_sessions = [item for item in requests if isinstance(item, dict) and 'initial_windows' in item]
assert len(new_sessions) == 1 and new_sessions[0]['label'] == 'Session'
args = new_sessions[0]['initial_windows'][0]['layout']['block']['options']['command']
assert 'task' in args and json.loads(args[args.index('task')+1])['session'] == {'kind': 'new', 'name': 'Session'}

pid, fd = start([binary, 'popup', '--context', repo], env)
try:
    data, at = frame(fd, (b'pty-source', b'Session', b'Tab next'), 0, b'')
    os.write(fd, b'\t\t\t\r')
    data, at = frame(fd, b'Create new worktree', at, data)
    os.write(fd, b'Create new worktree\x1b[B\r')
    data, at = frame(fd, b'Branch (', at, data)
    os.write(fd, b'feature/topic\r')
    data, at = frame(fd, (b'feature/topic', b'Tab next'), at, data)
    os.write(fd, b'\t\r')
    data, at = frame(fd, b'Directory (', at, data)
    checkout = root + '/custom-checkout'
    os.write(fd, b'\x15' + checkout.encode() + b'\r')
    data, at = frame(fd, (checkout.encode(), b'Tab next'), at, data)
    os.write(fd, b'\x13')
    finish(pid, fd)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise
with open(env['REX_PTY_LOG']) as f:
    requests = []
    for line in f:
        try: requests.append(json.loads(line))
        except ValueError: pass
created = [item for item in requests if isinstance(item, dict) and 'window_label' in item and 'layout' in item]
assert len(created) == 2
args = created[-1]['layout']['block']['options']['command']
task = json.loads(args[args.index('task')+1])
assert task['branch'] == 'feature/topic' and task['path'] == checkout
assert not os.path.exists(checkout)

duplicate_env = env.copy()
duplicate_env['REX_DUP_SESSIONS'] = '1'
pid, fd = start([binary, 'popup', '--context', repo], duplicate_env)
try:
    data, at = frame(fd, (b'pty-source', b'Tab next'), 0, b'')
    os.write(fd, b'\t\t\r')
    data, at = frame(fd, b'Esc back', at, data)
    os.write(fd, b'\x1b[B\x1b[B\r')
    data, at = frame(fd, (b'Same label', b'Tab next'), at, data)
    os.write(fd, b'\x13')
    finish(pid, fd)
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    raise
with open(env['REX_PTY_LOG']) as f:
    requests = []
    for line in f:
        try: requests.append(json.loads(line))
        except ValueError: pass
created = [item for item in requests if isinstance(item, dict) and 'window_label' in item and 'layout' in item]
assert created[-1]['session_id'] == 'second'
args = created[-1]['layout']['block']['options']['command']
assert json.loads(args[args.index('task')+1])['session'] == {'kind':'existing', 'id':'second'}

for name, target in [('git', git_bin), ('jj', jj_bin)]:
    with open(root+'/pty-bin/'+name, 'w') as f:
        f.write('#!/bin/sh\ncase "$1 $2" in "clone "*|"git clone") exec 3<>/dev/tty || exit 1;; esac\nexec '+json.dumps(target)+' "$@"\n')
    os.chmod(root+'/pty-bin/'+name, 0o755)
env['PATH'] = root+'/pty-bin:' + env.get('PATH', '')
pid, fd = start([lua, 'test/pty-child.lua', repo, root+'/pty-git-clone', root+'/pty-jj-clone'], env)
finish(pid, fd)
for name in ('pty-git-clone', 'pty-jj-clone'):
    with open(root+'/'+name+'/tracked') as f: assert f.read() == 'base\n'
task_repo = root + '/pty-clone-task'
task_env = env.copy()
task_env.update(REX_TASK_MODE='1', REX_SESSION='session', REX_BLOCK='block', SHELL='/bin/sh', ENV=root+'/shell-init')
with open(task_env['ENV'], 'w') as f:
    f.write('if ( : <>/dev/tty ); then exit 0; else exit 1; fi\n')
clone_input = {'vcs':'git', 'source':{'vcs':'git', 'url':repo, 'sourceHostId':'fixture-host', 'branches':['main'], 'branch':'main'}, 'repo':task_repo, 'session':{'kind':'existing','id':'session'}, 'name':'Task', 'branch':'main', 'branchMode':'existing', 'checkout':'primary'}
plan = {'vcs':'git', 'hostId':'fixture-host', 'repo':task_repo, 'existing':False, 'label':'Clone & Open', 'input':clone_input}
request = {'plan':plan, 'rexBinDir':root+'/pty-bin', 'rexLocalEndpoint':'unix:///fixture.sock'}
pid, fd = start([binary, 'clone-task', json.dumps(request)], task_env)
finish(pid, fd)
with open(task_repo+'/tracked') as f: assert f.read() == 'base\n'
with open(root+'/state/rex-worktrees/clone-root.json') as f: assert json.load(f)['cloneRoot'] == root
