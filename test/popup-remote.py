import json
import os
import signal
import sys

from terminal import Terminal

# The executable below is only the Rex protocol boundary; the popup and local Git are real.
if len(sys.argv) > 1 and sys.argv[1] == '--rex':
    args = sys.argv[2:]
    scenario = os.environ['POPUP_SCENARIO']
    root = os.environ['POPUP_ROOT']
    remote = '-S' in args and args[args.index('-S') + 1] == 'Remote machine'
    def emit(value):
        print(json.dumps(value))
    if args[-2:] == ['list', '--json'] and 'hosts' in args:
        emit({'home': {'label': 'Local', 'endpoint': 'unix:///fixture.sock', 'this_machine': True},
              'hosts': [{'host': {'id': 'remote', 'label': 'Remote machine', 'endpoints': ['tcp://remote']}}]})
    elif 'whoami' in args:
        emit({'host_id': 'host-remote' if remote else 'host-local', 'endpoint': 'tcp://remote' if remote else 'unix:///fixture.sock', 'principal': {'transport': 'tcp' if remote else 'unix'}})
    elif 'actions' in args:
        if scenario == 'connect':
            print('Remote helper unavailable; install and reload Rex', file=sys.stderr)
            sys.exit(4)
        emit({'actions': [{'name': 'worktrees_request', 'args': {'properties': {'request': {'type': 'string'}}}}]})
    elif 'worktrees_request' in args:
        request = json.loads(json.loads(args[args.index('--args') + 1])['request'])
        with open(os.environ['POPUP_LOG'], 'a') as log:
            log.write(json.dumps(request) + '\n')
        kind = request['kind']
        if scenario == 'pending' and kind == 'discover':
            signal.pause()
            sys.exit(1)
        base = {'version': 5, 'hostId': 'host-remote', 'kind': kind}
        remote_path = root + '/remote/alpha'
        project = {'vcs': 'git', 'path': remote_path, 'commonDir': remote_path + '/.git', 'name': 'alpha'}
        tree = {'vcs': 'git', 'path': remote_path, 'branch': 'main', 'head': 'abc', 'bare': False, 'locked': False, 'prunable': False}
        if kind == 'discover':
            base.update(sessions=[{'id': 'remote-session', 'label': 'Remote session'}], clients=[],
                        projects=[project] if scenario in ('existing', 'redirect', 'warning') else [],
                        roots=[root + '/clones'], cloneRoot=root + '/clones')
        elif kind == 'project':
            if scenario in ('existing', 'redirect', 'warning') and request['path'] == remote_path:
                base.update(project=project, checkout=project, worktrees=[tree], branches=['main', 'feature/free'], revisions=[], worktreeRoot=remote_path + '.worktrees')
            else:
                base.update(kind='project-missing', path=request['path'])
        elif kind == 'worktrees':
            base.update(repository=project, worktrees=[tree], branches=['main', 'feature/free'], revisions=[], worktreeRoot=remote_path + '.worktrees')
        elif kind == 'sessions':
            base.update(sessions=[{'id': 'remote-session', 'label': 'Remote session'}], clients=[])
        elif kind in ('plan', 'clone-plan'):
            value = request['input']
            if kind == 'clone-plan':
                if scenario in ('collision', 'permission') and value['repo'] == root + '/clones/alpha':
                    print('Clone destination already exists and is not a repository' if scenario == 'collision' else 'Cannot write clone destination parent', file=sys.stderr)
                    sys.exit(4)
                plan = {'vcs': 'git', 'input': value, 'hostId': 'host-remote', 'repo': value['repo'] + ('.changed' if scenario == 'clone-changed' else ''), 'existing': False, 'label': 'Clone & Open'}
            else:
                plan = {'vcs': 'git', 'input': value, 'hostId': 'host-remote', 'path': remote_path + ('.changed' if scenario == 'redirect' else ''), 'action': 'new-tab', 'checkout': 'existing', 'branch': 'main', 'nameRole': 'tab', 'name': value['name'], 'label': 'Open tab'}
                if scenario == 'warning': plan['warning'] = 'Multiple Rex apps are connected'
            base['plan'] = plan
        elif kind in ('launch', 'clone-launch'):
            if scenario == 'clone-failure':
                print('Destination request rejected', file=sys.stderr)
                sys.exit(4)
            result = {'hostId': 'host-remote', 'sessionId': 'remote-session', 'windowId': 'window', 'blockId': 'block', 'pending': kind == 'clone-launch'}
            if kind == 'clone-launch':
                result['repo'] = request['reviewed']['repo']
                if scenario == 'clone-warning': result['warning'] = 'Multiple Rex apps are connected'
            else:
                result.update(path=request['reviewed']['path'], action='new-tab')
            base['result'] = result
        else:
            raise AssertionError(request)
        emit(json.dumps(base))
    elif 'ls' in args:
        emit({'sessions': [{'session_id': 'local-session', 'label': 'Local session'}]})
    elif 'client.list' in args:
        emit({'clients': []})
    elif 'session.list_blocks' in args:
        emit({'blocks': []})
    else:
        print('unexpected Rex call ' + repr(args), file=sys.stderr)
        sys.exit(1)
    sys.exit(0)

root, binary, repo = sys.argv[1:]
bin_dir = root + '/bin'
os.makedirs(bin_dir, exist_ok=True)
with open(bin_dir + '/rex', 'w') as script:
    script.write('#!/bin/sh\nexec ' + json.dumps(sys.executable) + ' ' + json.dumps(os.path.abspath(__file__)) + ' --rex "$@"\n')
os.chmod(bin_dir + '/rex', 0o755)

class Popup(Terminal):
    def __init__(self, scenario):
        self.log = root + '/' + scenario + '.jsonl'
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_') and k not in ('REX_SESSION', 'REX_BLOCK', 'REX_CLIENT', 'REX_SERVER', 'REX_HOST')}
        home = root + '/home-' + scenario
        os.makedirs(home, exist_ok=True)
        env.update(HOME=home, XDG_CONFIG_HOME=home + '/config', XDG_STATE_HOME=home + '/state',
                   GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=home + '/gitconfig', NO_COLOR='1',
                   REX_BIN_DIR=bin_dir, REX_WORKTREES_LOCAL_ENDPOINT='unix:///fixture.sock',
                   REX_WORKTREES_CONFIG=json.dumps({'directory': home, 'config': {}}),
                   POPUP_ROOT=root, POPUP_LOG=self.log, POPUP_SCENARIO=scenario)
        super().__init__(scenario, self.log, binary, repo, env, 20, 110)

    def switch(self):
        self.frame('alpha', 'Local session', 'Tab next')
        self.send(b'\t\r')
        self.frame('Execution machine', 'Esc back')
        self.send(b'\x1b[B\r')

    def directory(self, value, tabs):
        self.send(b'\t' * tabs + b'\r')
        self.frame('Directory (absolute path', 'Esc back')
        self.send(b'\x15' + value.encode() + b'\r')
        self.frame(value, 'Tab next')


def run(scenario, fn):
    popup = Popup(scenario)
    try:
        fn(popup)
    finally:
        popup.close()


def existing(p):
    p.switch()
    path = root + '/remote/alpha'
    p.frame('alpha', 'Remote session', 'Tab next')
    assert not p.requests('clone-plan')
    p.send(b'\x13')
    p.finish()
    review, launch = p.requests('plan'), p.requests('launch')
    assert len(review) == len(launch) == 1
    assert review[0]['input']['path'] == path and launch[0]['reviewed']['path'] == path
    assert review[0]['input']['session'] == {'kind': 'existing', 'id': 'remote-session'}
    assert review[0]['input']['additional'] is False and review[0]['input']['split'] is False
    assert not p.requests('clone-source') and not p.requests('clone-launch')


def pending(p):
    p.switch()
    frame = p.frame('Remote machine', 'Connecting to Remote machine', 'Tab next')
    assert 'WORKTREE        alpha' not in frame and 'Local session' not in frame and 'host-local' not in frame
    p.send(b'\x13')
    p.send(b'\x1b')
    p.finish()
    assert not p.requests('plan') and not p.requests('launch')


def connect(p):
    p.switch()
    frame = p.frame('Remote helper unavailable', 'Tab next')
    assert 'Remote machine' in frame and 'Local session' not in frame and 'host-local' not in frame
    p.send(b'\x1b')
    p.finish()
    assert not p.requests('launch')


def clone(p):
    p.switch()
    destination = root + '/clones/alpha'
    frame = p.frame('Remote session', 'Project checkout (after clone)', 'Tab next')
    assert 'main' in frame and 'New tab (cloning)' in frame
    if p.scenario in ('collision', 'permission'):
        p.send(b'\x13')
        p.frame('Clone destination already exists' if p.scenario == 'collision' else 'Cannot write clone destination', 'Tab next')
        assert not p.requests('clone-launch')
        p.directory(root + '/safe/alpha', 4)
    elif p.scenario == 'worktree':
        p.send(b'\t\t\r')
        p.frame('Worktree (select existing or create new)', 'Esc back')
        p.send('Create new worktree'.encode() + b'\x1b[B\r')
        p.frame('Branch (select unused or type new name)', 'Esc back')
        p.send(b'feature/new\r')
        p.frame('feature/new', 'Tab next')
        p.directory(root + '/custom/task', 1)
    else:
        p.directory(root + '/safe/alpha', 4)
    p.send(b'\x13')
    if p.scenario == 'clone-changed':
        p.frame('Clone destination changed; edit the destination:', 'Tab next')
        p.send(b'\x13\x1b')
        p.finish()
        assert len(p.requests('clone-plan')) == 1 and not p.requests('clone-launch')
        return
    if p.scenario == 'clone-failure':
        frame = p.frame('Clone needs inspection', 'Destination request rejected', 'Enter / Space close')
        assert 'exited 4' in frame
        assert p.requests('clone-launch')[0]['input']['repo'] == root + '/safe/alpha'
        p.send(b'\r')
        p.finish(False)
        return
    if p.scenario == 'clone-warning':
        p.frame('Clone task submitted with warning', 'Multiple Rex apps are connected', 'Enter / Space close')
        p.send(b'\r')
    p.finish()
    plans, launches = p.requests('clone-plan'), p.requests('clone-launch')
    assert len(launches) == 1 and len(plans) == (2 if p.scenario in ('collision', 'permission') else 1)
    value = launches[0]['input']
    assert value['source']['url'] == 'https://example.test/alpha.git' and value['source']['sourceHostId'] == 'host-local'
    assert value['session'] == {'kind': 'existing', 'id': 'remote-session'}
    if p.scenario == 'worktree':
        assert value['repo'] == destination and value['directory'] == root + '/custom/task'
        assert value['checkout'] == 'worktree' and value['branch'] == 'feature/new' and value['branchMode'] == 'create'
    else:
        assert value['repo'] == root + '/safe/alpha' and value['checkout'] == 'primary'
        assert value['branch'] == 'main' and value['branchMode'] == 'existing'
    assert launches[0]['reviewed']['repo'] == value['repo']
    assert not os.path.exists(value['repo'])


def redirect(p):
    p.switch()
    p.frame('alpha', 'Remote session', 'Tab next')
    p.send(b'\x13')
    p.frame('Destination changed; select the worktree again:', 'Tab next')
    p.send(b'\x13\x1b')
    p.finish()
    assert len(p.requests('plan')) == 1 and not p.requests('launch')


def warning(p):
    p.switch()
    p.frame('alpha', 'Remote session', 'Tab next')
    p.send(b'\x13')
    p.frame('Opened with warning', 'Multiple Rex apps are connected', 'Enter / Space close')
    assert len(p.requests('launch')) == 1
    p.send(b'\r')
    p.finish()


def editor_cancel(p):
    p.frame('alpha', 'Local session', 'Tab next')
    p.send(b'\t\r')
    p.frame('Execution machine', 'Esc back')
    p.send(b'\x1b')
    p.frame('alpha', 'Tab next')
    p.send(b'\r')
    p.frame('Execution machine', 'Esc back')
    p.send(b'\x1b')
    p.frame('alpha', 'Tab next')
    p.send(b'\x1b[Z\r')
    p.frame('Project (select known', 'Esc back')
    p.send(b'\x1b')
    p.frame('alpha', 'Tab next')
    p.send(b'\x1b')
    p.finish()
    assert not p.requests('plan') and not p.requests('launch')


for scenario, fn in [('existing', existing), ('pending', pending), ('connect', connect),
                     ('collision', clone), ('permission', clone), ('worktree', clone),
                     ('clone-changed', clone), ('clone-warning', clone), ('clone-failure', clone),
                     ('redirect', redirect), ('warning', warning), ('editor-cancel', editor_cancel)]:
    run(scenario, fn)
