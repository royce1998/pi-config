---
name: pi-config
description: Back up, sync, and update the user's pi configuration (skills, extensions, settings) via the git repo at ~/.pi (GitHub remote royce1998/pi-config). Use whenever the user wants to save/commit/push pi changes, sync config to another computer, clone/set up pi on a new machine, add or edit a skill and persist it, or check that no secrets are about to be committed.
---

# pi-config

The user's pi configuration lives in a git repo so it can be synced across
machines and shared. This skill explains how to save changes, set up a new
machine, and avoid committing secrets.

## Facts

- **Repo root:** `~/.pi` (the whole pi home dir is the working tree)
- **Remote:** `origin` → https://github.com/royce1998/pi-config (private)
- **Branch:** `main`
- **Commit email:** repo-local `user.email` is set to the GitHub noreply
  address `19889513+royce1998@users.noreply.github.com` (GitHub blocks pushes
  that expose the real private email). Don't change this to the plain gmail.

### What is tracked (safe to share)
- `agent/skills/` — custom skills
- `agent/extensions/` — extension source (`index.ts`, `package.json`, `package-lock.json`, `README.md`)
- `agent/settings.json`, `agent/models.json`
- `.gitignore`, `.gitattributes`, `README.md`

### What is intentionally IGNORED (secrets / personal / huge / regenerable)
Defined in `~/.pi/.gitignore`:
- `agent/auth.json` (OAuth tokens) and any `token.json`, `tokens*.txt`, `*credential*`, `*secret*`, `*.pem`, `*.key`
- `agent/sessions/`, `agent/fleet/`, `agent/job-search/` (browser profiles, Gmail tokens, resumes, application data)
- `agent/bin/` (fd.exe / rg.exe — reinstall per machine)
- all `**/node_modules/`
- runtime junk under `agent/skills/job-search/scripts/` (`*.log`, `err.txt`, `arthur_unread.json`)

## Save changes (commit + push)

Run from the repo root. ALWAYS sanity-check for secrets first.

```bash
cd ~/.pi
git add -A
# Safety check — must print "clean" before committing:
git ls-files --cached | grep -Ei 'auth\.json|sessions/|fleet/|agent/job-search/|node_modules|\.exe$|token|credential|secret|\.pem$|\.key$' && echo "STOP: sensitive file staged" || echo "clean"
git status --short
git commit -m "<describe the change>"
git push
```

If the safety check flags something, unstage it and add its path to
`~/.pi/.gitignore` before committing:
```bash
git rm --cached <path>
echo '<path>' >> ~/.pi/.gitignore
```

## Add or change a skill, then persist it

1. Create/edit the skill under `~/.pi/agent/skills/<name>/SKILL.md`.
2. Keep runtime artifacts (logs, tokens, scraped data) OUT of the repo — add
   their paths to `.gitignore`.
3. Save with the commit + push steps above.

## Set up on a new machine

```bash
git clone https://github.com/royce1998/pi-config ~/.pi
cd ~/.pi/agent/extensions/browser && npm install    # restore extension deps
# Re-authenticate (creates a local, untracked agent/auth.json):
pi        # then run /login for the provider
# Optional: reinstall fd/rg into agent/bin if a skill needs them.
```

## Pull latest on an existing machine

```bash
cd ~/.pi && git pull --rebase
```

## Notes

- The person you share the repo with authenticates with their OWN accounts;
  no logins/tokens are included by design.
- CRLF warnings on Windows are harmless (`.gitattributes` sets `eol=lf`).
- Never `git add -f` an ignored file unless you are certain it holds no secrets.
