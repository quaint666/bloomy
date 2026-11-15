#!/usr/bin/env python3
"""Run the steps of .github/workflows/build.yml on this machine, in order, the way the CI runner would.

Use it before pushing a change to the workflow, a Dockerfile, or anything CI builds or tests. From the repository root:
    python3 deploy/scripts/ci_dryrun.py
It needs Docker and PyYAML, and takes about two minutes with a warm Docker cache.

What it does
- Takes the `run:` text of every step and runs it with `bash -e`, with the job's `env:` and the tag computed from HEAD.
- Builds local images named bloomy-trial/app and bloomy-trial/schema, on a network and containers named bloomy-ci-trial*,
  and removes them in the Clean up step. Nothing is pulled from or pushed to the registry.
- Skips `uses:` steps (checkout), steps that only run on main (login and push), and "if: failure()" steps unless
  something failed. Prints each step's result with the tail of its output, then ALL STEPS PASSED or FAILED.

What it does NOT prove
- Anything about the real GitHub runner: its Docker version, BuildKit, network, or secrets.
- The skipped steps. The `docker logout` line of the Clean up step is removed so this never logs out your own Docker client.
- Cold-cache behaviour: layers cached on this machine hide downloads (`apk add`, the PostgreSQL archive).
"""
import yaml, subprocess, os, sys, tempfile, re, time

d = yaml.safe_load(open('.github/workflows/build.yml'))
job = d['jobs']['build']
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
env = dict(os.environ)
for k, v in job['env'].items():
    env[k] = str(v)
# local image names (nothing is pulled or pushed) and a fixed run id
env['APP_IMAGE'] = 'bloomy-trial/app'; env['SCHEMA_IMAGE'] = 'bloomy-trial/schema'; env['CI_NAME'] = 'bloomy-ci-trial'
env.update({'GITHUB_SHA': sha, 'GITHUB_REF': 'refs/heads/trial-merge', 'GITHUB_WORKSPACE': os.getcwd()})
failed = False
results = []

def run_step(step):
    global failed
    script = step['run']
    if step.get('name') == 'Clean up':   # never log the real docker client out of the real registry
        script = script.replace('docker logout "$REGISTRY" || true', 'true')
    genv = tempfile.NamedTemporaryFile('w+', delete=False); genv.close()
    e = dict(env); e['GITHUB_ENV'] = genv.name
    for k, v in (step.get('env') or {}).items():
        e[k] = str(v).replace('${{ github.sha }}', sha)
    t = time.time()
    p = subprocess.run(['bash', '-e', '-c', script], env=e, capture_output=True, text=True)
    for line in open(genv.name).read().splitlines():
        if '=' in line:
            k, v = line.split('=', 1); env[k] = v
    out = (p.stdout + p.stderr).strip().splitlines()
    results.append((step['name'], p.returncode, time.time() - t, out))
    if p.returncode != 0:
        failed = True

for step in job['steps']:
    name = step.get('name', step.get('uses', '?'))
    cond = str(step.get('if', ''))
    if 'uses' in step: results.append((name, 'skipped (action)', 0, [])); continue
    if 'github.ref' in cond: results.append((name, 'skipped (main only: push)', 0, [])); continue
    if cond == 'failure()':
        if not failed: results.append((name, 'skipped (nothing failed)', 0, [])); continue
    elif cond == 'always()': pass
    elif failed: results.append((name, 'skipped (an earlier step failed)', 0, [])); continue
    run_step(step)

print("TAG used:", env.get('TAG'))
for name, rc, secs, out in results:
    status = rc if isinstance(rc, str) else ("OK" if rc == 0 else f"FAILED (exit {rc})")
    print(f"\n### {name}\n    -> {status}" + (f"  [{secs:.0f}s]" if secs else ""))
    for l in out[-6:]: print("      | " + l[:160])
print("\nWORKFLOW RESULT:", "FAILED" if failed else "ALL STEPS PASSED")
sys.exit(1 if failed else 0)
