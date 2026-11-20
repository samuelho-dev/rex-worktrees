import json
import os
import pty
import select
import signal
import sys
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
case " $* " in
 *' hosts list '*) echo '{"home":{"label":"Local","endpoint":"unix:///fixture.sock","this_machine":true},"hosts":[]}' ;;
 *' whoami '*) echo '{"host_id":"fixture-host","endpoint":"unix:///fixture.sock","principal":{"transport":"unix"}}' ;;
 *' ls '*) echo '{"sessions":[{"session_id":"session","label":"Session"}]}' ;;
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
    return pid, fd

def finish(pid, fd, prompts):
    deadline = time.monotonic() + 15
    output = b''
    pending = b''
    answered = 0
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            os.close(fd)
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise AssertionError('PTY process failed: '+repr(output[-3000:]))
            assert answered == prompts, (answered, prompts, output[-3000:])
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); raise AssertionError('PTY timeout')
        if select.select([fd], [], [], remaining)[0]:
            try:
                chunk = os.read(fd, 65536)
                output += chunk
                pending += chunk
                while b'PTY_AUTH_PROMPT:' in pending:
                    pending = pending.split(b'PTY_AUTH_PROMPT:', 1)[1]
                    os.write(fd, b'fixture-credential\n')
                    answered += 1
            except OSError:
                pass

for name, target in [('git', git_bin), ('jj', jj_bin)]:
    with open(root+'/pty-bin/'+name, 'w') as f:
        f.write('#!/bin/sh\ncase "$1 $2" in "clone "*|"git clone") exec 3<>/dev/tty || exit 1; printf PTY_AUTH_PROMPT: >&3; IFS= read -r answer <&3; [ "$answer" = fixture-credential ] || exit 1;; esac\nexec '+json.dumps(target)+' "$@"\n')
    os.chmod(root+'/pty-bin/'+name, 0o755)
env['PATH'] = root+'/pty-bin:' + env.get('PATH', '')
pid, fd = start([lua, 'test/pty-child.lua', repo, root+'/pty-git-clone', root+'/pty-jj-clone'], env)
finish(pid, fd, 2)
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
finish(pid, fd, 1)
with open(task_repo+'/tracked') as f: assert f.read() == 'base\n'
with open(root+'/state/rex-worktrees/clone-root.json') as f: assert json.load(f)['cloneRoot'] == root
