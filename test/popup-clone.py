import json
import os
import sys

from terminal import Terminal

# Only the Rex transport is faked. Discovery and clone-source on the local host are real.
if len(sys.argv) > 1 and sys.argv[1] == '--rex':
    args = sys.argv[2:]
    root, scenario = os.environ['POPUP_ROOT'], os.environ['POPUP_SCENARIO']
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
        base = {'version': 5, 'hostId': 'host-remote', 'kind': kind}
        remote_path = root + '/remote/alpha'
        project = {'vcs': 'jj', 'path': remote_path, 'commonDir': remote_path + '/.jj/repo', 'name': 'alpha'}
        tree = {'vcs': 'jj', 'path': remote_path, 'name': 'alpha', 'head': 'c' * 40, 'changeId': 'm' * 32, 'present': True}
        revisions = [{'expression': 'trunk()', 'label': 'trunk()', 'revision': {'commitId': 'a' * 40, 'changeId': 'k' * 32, 'description': 'mainline'}},
                     {'expression': 'candidate', 'label': 'candidate', 'revision': {'commitId': 'b' * 40, 'changeId': 'n' * 32, 'description': 'candidate'}}]
        if kind == 'discover':
            base.update(sessions=[{'id': 'remote-session', 'label': 'Remote session'}], clients=[],
                        projects=[project] if scenario.startswith('jj-') else [],
                        roots=[root + '/remote-clones'], cloneRoot=root + '/remote-clones')
        elif kind == 'project':
            if scenario.startswith('jj-') and request['path'] == remote_path:
                base.update(project=project, checkout=project, worktrees=[tree], branches=[], revisions=revisions, worktreeRoot=remote_path + '.worktrees')
            else:
                base.update(kind='project-missing', path=request['path'])
        elif kind == 'worktrees':
            base.update(repository=project, worktrees=[tree], branches=[], revisions=revisions, worktreeRoot=remote_path + '.worktrees')
        elif kind == 'plan':
            value = request['input']
            base['plan'] = {'vcs': 'jj', 'input': value, 'hostId': 'host-remote', 'path': value['directory'], 'action': 'new-tab', 'checkout': 'create', 'workspaceName': value['worktreeName'], 'nameRole': 'tab', 'name': value['name'], 'label': 'Create workspace & open'}
        elif kind == 'launch':
            base['result'] = {'hostId': 'host-remote', 'sessionId': 'remote-session', 'windowId': 'window', 'blockId': 'block', 'pending': False, 'path': request['reviewed']['path'], 'action': 'new-tab'}
        elif kind == 'clone-plan':
            value = request['input']
            base['plan'] = {'vcs': 'git', 'input': value, 'hostId': 'host-remote', 'repo': value['repo'], 'existing': False, 'label': 'Clone & Open'}
        elif kind == 'clone-launch':
            if scenario == 'failure':
                print('Destination request rejected', file=sys.stderr)
                sys.exit(4)
            base['result'] = {'hostId': 'host-remote', 'sessionId': 'remote-session', 'windowId': 'window', 'blockId': 'block', 'pending': True, 'repo': request['reviewed']['repo']}
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

root, binary = sys.argv[1:]
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
                   REX_WORKTREES_CONFIG=json.dumps({'directory': home, 'config': {'roots': [home + '/local-clones']}}),
                   POPUP_ROOT=root, POPUP_LOG=self.log, POPUP_SCENARIO=scenario)
        repo = root + ('/jj/alpha' if scenario.startswith('jj-') else '/detached/alpha' if scenario == 'detached' else '/git/alpha')
        super().__init__(scenario, self.log, binary, repo, env, 24, 110, normalize=False)

    def switch(self):
        self.frame('alpha', 'Local session', 'Tab next')
        self.send(b'\t\r')
        self.frame('Execution machine', 'Esc back')
        self.send(b'\x1b[B\r')

    def directory(self, value, tabs):
        self.send(b'\t' * tabs + b'\r')
        self.frame('Directory (absolute path', 'Esc back')
        self.send(b'\x15' + value.encode() + b'\r')
        self.frame(value[:35], 'DIRECTORY', 'Tab next')


def workspace(p):
    p.switch()
    p.frame('alpha', 'Remote session', 'Tab next')
    p.send(b'\t\t\r')
    p.frame('Workspace (select existing or create new)', 'Create new workspace')
    p.send('Create new workspace'.encode() + b'\x1b[B\r')
    default = root + '/remote/alpha.worktrees/workspace'
    frame = p.frame('Create new workspace', 'trunk()', 'DIRECTORY')
    assert 'START FROM' in frame and 'DIRECTORY' in frame
    expected, revision, name = default, 'a' * 40, 'workspace'
    if p.scenario == 'jj-custom':
        p.send(b'\t\r')
        p.frame('Start from revision for new workspace')
        p.send(b'candidate\x1b[B\r')
        p.frame('candidate', 'Tab next')
        expected, revision, name = root + '/custom/task-space', 'b' * 40, 'task-space'
        p.directory(expected, 1)
    assert not p.requests('plan') and not p.requests('launch')
    p.send(b'\x13')
    p.finish()
    plans, launches = p.requests('plan'), p.requests('launch')
    assert len(plans) == len(launches) == 1
    value = launches[0]['input']
    assert value['vcs'] == 'jj' and value['repo'] == root + '/remote/alpha'
    assert value['directory'] == expected and value['worktreeName'] == name and value['revision'] == revision
    assert value['session'] == {'kind': 'existing', 'id': 'remote-session'}
    assert plans[0]['input'] == value and launches[0]['reviewed']['path'] == expected


def clone(p):
    p.switch()
    destination = root + '/remote-clones/alpha'
    frame = p.frame('DIRECTORY', 'Project checkout (after clone)', 'New tab (cloning)')
    assert ('Select or type branch' if p.scenario == 'detached' else 'main') in frame
    if p.scenario == 'detached':
        p.send(b'\t\t\t\r')
        p.frame('Branch (select unused or type new name)', 'main')
        p.send(b'\x1b[B\r')
        p.frame('main', 'Tab next')
        p.directory(root + '/remote-safe/alpha', 1)
    elif p.scenario == 'worktree':
        p.send(b'\t\t\r')
        p.frame('Worktree (select existing or create new)', 'Project checkout (after clone)', 'Create new worktree')
        p.send(b'Create new worktree\x1b[B\r')
        p.frame('Branch (select unused or type new name)')
        p.send(b'feature/new\r')
        p.frame('feature/new', 'Tab next')
        p.directory(root + '/remote-checkouts/task', 1)
    else:
        p.directory(root + '/remote-safe/alpha', 4)
    assert not p.requests('clone-plan') and not p.requests('clone-launch')
    p.send(b'\x13')
    if p.scenario == 'failure':
        frame = p.frame('Clone needs inspection', 'Destination request rejected', 'Enter / Space close')
        assert 'exited 4' in frame and root[:35] in frame
        p.send(b'\x13')
        p.frame('Clone needs inspection', 'Enter / Space close')
        assert 'request-body-' not in frame
        assert len(p.requests('clone-plan')) == len(p.requests('clone-launch')) == 1
        p.send(b'\r')
        p.finish(False)
    else:
        p.finish()
    plans, launches = p.requests('clone-plan'), p.requests('clone-launch')
    assert len(plans) == len(launches) == 1
    value = launches[0]['input']
    assert plans[0]['input'] == value and launches[0]['reviewed']['repo'] == value['repo']
    assert value['source']['url'] == 'https://example.test/alpha.git' and value['source']['sourceHostId'] == 'host-local'
    assert value['session'] == {'kind': 'existing', 'id': 'remote-session'}
    if p.scenario == 'detached': assert 'branch' not in value['source']
    if p.scenario == 'worktree':
        assert value['repo'] == destination and value['directory'] == root + '/remote-checkouts/task'
        assert value['checkout'] == 'worktree' and value['branch'] == 'feature/new' and value['branchMode'] == 'create'
    else:
        assert value['repo'] == root + '/remote-safe/alpha' and value['checkout'] == 'primary'
        assert 'directory' not in value and value['branch'] == 'main' and value['branchMode'] == 'existing'
    assert not os.path.exists(value['repo'])


for scenario in ('jj-default', 'jj-custom', 'detached', 'primary', 'worktree', 'failure'):
    popup = Popup(scenario)
    try:
        (workspace if scenario.startswith('jj-') else clone)(popup)
    finally:
        popup.close()
