# my pi config

Portable configuration for [pi](https://github.com/earendil-works/pi-coding-agent):
skills, extensions, and settings. Lives at `~/.pi` so you can sync it across
machines or hand it to someone else.

## What's tracked

| Path | What |
|------|------|
| `agent/skills/`     | Custom skills (job-search, solve-captcha, …) |
| `agent/extensions/` | Extension source (browser, supervisor) — `index.ts`, `package.json` |
| `agent/settings.json` | UI/model/compaction settings |
| `agent/models.json`   | Provider/model overrides |

## What's intentionally NOT tracked

Secrets and personal/large data are excluded via `.gitignore`:
`auth.json` (OAuth tokens), `sessions/`, `fleet/`, `job-search/` (browser
profiles, Gmail tokens, resumes), `bin/*.exe`, and all `node_modules/`.

## Set up on a new machine

```bash
# 1. Clone into ~/.pi
git clone <your-repo-url> ~/.pi

# 2. Reinstall extension dependencies
cd ~/.pi/agent/extensions/browser && npm install

# 3. Re-authenticate (creates agent/auth.json locally — never committed)
pi        # then run /login  (or your provider's auth flow)

# 4. (optional) reinstall fd/rg into agent/bin if a skill needs them
```

## Save changes later

```bash
cd ~/.pi
git add -A
git commit -m "update skills/settings"
git push
```
