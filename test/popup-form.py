import json
import os
import sys

from terminal import Terminal

# Rex is the protocol boundary; the popup and local repository are real.
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
        emit({'actions': [{'name': 'worktrees_request', 'args': {'properties': {'request': {'type': 'string'}}}}]})
    elif 'worktrees_request' in args:
        request = json.loads(json.loads(args[args.index('--args') + 1])['request'])
        with open(os.environ['POPUP_LOG'], 'a') as log:
            log.write(json.dumps(request) + '\n')
        kind = request['kind']
        assert request['version'] == 5
        base = {'version': 5, 'hostId': 'host-remote', 'kind': kind}
        remote_path = root + '/remote/' + ('nested/' * 25 if scenario == 'long' else '') + 'alpha'
        project = {'vcs': 'git', 'path': remote_path, 'commonDir': remote_path + '/.git', 'name': 'alpha'}
        tree = {'vcs': 'git', 'path': remote_path, 'branch': 'main', 'head': 'abc', 'bare': False, 'locked': False, 'prunable': False}
        if kind == 'discover':
            base.update(sessions=[{'id': 'remote-session', 'label': 'Remote session'}], clients=[], projects=[project], roots=[root + '/clones'], cloneRoot=root + '/clones')
        elif kind == 'project':
            assert request['path'] == remote_path
            base.update(project=project, checkout=project, worktrees=[tree], branches=['main', 'feature/free'], revisions=[], worktreeRoot=remote_path + '.worktrees')
        elif kind == 'worktrees':
            base.update(repository=project, worktrees=[tree], branches=['main', 'feature/free'], revisions=[], worktreeRoot=remote_path + '.worktrees')
        elif kind == 'sessions':
            base.update(sessions=[{'id': 'remote-session', 'label': 'Remote session'}], clients=[])
        elif kind == 'plan':
            value = request['input']
            destination = value.get('path', value.get('directory'))
            plan = {'vcs': 'git', 'input': value, 'hostId': 'host-remote', 'path': destination + ('.changed' if scenario == 'redirect' else ''),
                    'action': 'new-tab', 'checkout': 'existing' if 'path' in value else 'create',
                    'branch': value.get('branch', 'main'), 'nameRole': 'tab', 'name': value['name'], 'label': 'Open tab'}
            if scenario == 'warning': plan['warning'] = 'Multiple Rex apps are connected'
            base['plan'] = plan
        elif kind == 'launch':
            base['result'] = {'hostId': 'host-remote', 'sessionId': 'remote-session', 'windowId': 'window', 'blockId': 'block',
                              'pending': False, 'path': request['reviewed']['path'], 'action': 'new-tab'}
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
        raise AssertionError(args)
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
        home = root + '/home-' + scenario
        os.makedirs(home, exist_ok=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_') and k not in ('REX_SESSION', 'REX_BLOCK', 'REX_CLIENT', 'REX_SERVER', 'REX_HOST')}
        env.update(HOME=home, XDG_CONFIG_HOME=home + '/config', XDG_STATE_HOME=home + '/state',
                   GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=home + '/gitconfig', NO_COLOR='1',
                   REX_BIN_DIR=bin_dir, REX_WORKTREES_LOCAL_ENDPOINT='unix:///fixture.sock',
                   REX_WORKTREES_CONFIG=json.dumps({'directory': home, 'config': {}}),
                   POPUP_ROOT=root, POPUP_LOG=self.log, POPUP_SCENARIO=scenario)
        super().__init__(scenario, self.log, binary, repo, env, 20, 60 if scenario == 'long' else 110)

    def switch(self):
        self.frame('alpha', 'Local session', 'Tab next')
        self.send(b'\t\r')
        self.frame('Execution machine', 'Esc back')
        self.send(b'\x1b[B\r')
        return self.frame('Remote session', 'Tab next')

    def no_submit(self):
        assert not self.requests('plan') and not self.requests('launch')

    def launched(self, path, additional=False, split=False):
        plans, launches = self.requests('plan'), self.requests('launch')
        assert len(plans) == len(launches) == 1, (plans, launches)
        value = plans[0]['input']
        assert value['session'] == {'kind': 'existing', 'id': 'remote-session'}
        assert value['additional'] is additional and value['split'] is split
        assert value.get('path', value.get('directory')) == path
        assert launches[0]['input'] == value and launches[0]['reviewed']['path'] == path
        return value


def run(scenario, fn):
    popup = Popup(scenario)
    try:
        fn(popup)
    finally:
        popup.close()


def project(p, accept):
    p.switch()
    p.send(b'\x1b[Z\r')
    p.frame('Project (select known', 'Esc back')
    p.send(b'\x1b[B\x1b[B')
    frame = p.frame('Project (select known', '› alpha', 'Esc back')
    assert 'Tab next' not in frame
    p.send(accept)
    frame = p.frame('Remote session', 'WORKTREE', 'Tab next', absent=('Loading…',))
    assert 'alpha' in frame
    p.no_submit()
    p.send(b'\x13')
    p.finish()
    p.launched(root + '/remote/alpha')


def mode(p, choice, text, additional, split):
    initial = p.switch()
    p.send(b'\t\t\t\r')
    editor = p.frame('Open mode', 'Esc back')
    for label in ('PROJECT', 'MACHINE', 'SESSION', 'WORKTREE', 'BRANCH', 'DIRECTORY', 'MODE'):
        assert initial.splitlines().index(next(line for line in initial.splitlines() if label in line)) == editor.splitlines().index(next(line for line in editor.splitlines() if label in line))
    p.send(choice + b'\x13')
    p.frame(text, 'Tab next')
    p.no_submit()
    p.send(b'\x13')
    p.finish()
    p.launched(root + '/remote/alpha', additional, split)


def occupied(p):
    p.switch()
    p.send(b'\t\t\r')
    p.frame('Worktree (select existing or create new)', 'Esc back')
    p.send(b'Create new worktree\x1b[B\r')
    p.frame('Branch (select unused or type new name)', 'Esc back')
    p.send(b'main\r')
    p.frame('Branch main is already checked out', 'Tab next')
    p.send(b'\x13')
    p.frame('Branch main is already checked out', 'Tab next')
    p.no_submit()
    p.send(b'\r')
    p.frame('Branch (select unused or type new name)', 'Esc back')
    p.send(b'feature/new\r')
    p.frame('feature/new', 'Tab next')
    p.no_submit()
    p.send(b'\x13')
    p.finish()
    value = p.launched(root + '/remote/alpha.worktrees/feature/new')
    assert value['branch'] == 'feature/new' and 'path' not in value


def redirect(p):
    p.switch()
    p.send(b'\x13')
    p.frame('Destination changed; select the worktree again:', 'Tab next')
    p.send(b'\x13')
    p.frame('Destination changed; select the worktree again:', 'Tab next')
    assert len(p.requests('plan')) == 1 and not p.requests('launch')
    p.send(b'\x1b')
    p.finish()
    assert len(p.requests('plan')) == 1 and not p.requests('launch')


def warning(p):
    p.switch()
    p.send(b'\x13')
    p.frame('Opened with warning', 'Multiple Rex apps are connected', 'Enter / Space close')
    p.launched(root + '/remote/alpha')
    p.send(b'\r')
    p.finish()
    p.launched(root + '/remote/alpha')


def long_path(p):
    frame = p.switch()
    path = root + '/remote/' + 'nested/' * 25 + 'alpha'
    lines = frame.splitlines()
    branch = next(line for line in lines if 'BRANCH' in line)
    directory = next(line for line in lines if 'DIRECTORY' in line)
    assert 'main' in branch and '…' in directory and path not in directory
    p.send(b'\t\t\r')
    p.frame('Worktree (select existing or create new)', 'Esc back')
    p.send(b'\x1b')
    p.frame('DIRECTORY', 'Tab next')
    p.no_submit()
    p.send(b'\t\r')
    p.frame('Open mode', 'Esc back')
    p.send(b'\x1b')
    p.frame('DIRECTORY', 'Tab next')
    p.no_submit()
    p.send(b'\x13')
    p.finish()
    p.launched(path)


for name, accept in [('project-enter', b'\r'), ('project-ctrls', b'\x13')]:
    run(name, lambda p, accept=accept: project(p, accept))
for name, choice, text, additional, split in [
    ('mode-auto', b'', 'Reuse matching tab, otherwise new tab', False, False),
    ('mode-new-tab', b'\x1b[B', 'Always new tab', True, False),
    ('mode-split', b'\x1b[B\x1b[B', 'Split matching tab, otherwise new tab', False, True),
]:
    run(name, lambda p, choice=choice, text=text, additional=additional, split=split: mode(p, choice, text, additional, split))
for name, fn in [('occupied', occupied), ('redirect', redirect), ('warning', warning), ('long', long_path)]:
    run(name, fn)
