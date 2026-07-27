# Gmail helper for the job-search skill

`gmail_cli.py` lets the job-search agent read and act on a person's
job-application email through the Gmail API: confirm "application received"
messages, detect assessment / online-assessment invites, spot recruiter
follow-ups asking for info or to schedule, download attachments, and draft or
send replies.

The skill (`../SKILL.md`, section **"Email (Gmail) integration"**) explains when
and how the agent uses this, **including how the agent does the OAuth setup for
the user by driving the browser** ("First-time setup (you do this)"). This file
is a reference for the same setup plus a manual fallback.

## Setup — the agent does this for you (recommended)

The agent creates the OAuth client by driving Google Cloud Console in the Chrome
window (which is signed into your Google account) and completes consent there
too. You only: (1) sign into Google once in that window, and (2) if the agent
can't click it, press the final **Allow**. See `../SKILL.md` for the exact
step-by-step the agent follows. In short it will:

1. `pip install -r requirements.txt`
2. Create/select a Cloud project and **enable the Gmail API**.
3. Configure the OAuth consent screen (External) and add you as a **test user**.
4. Create an **OAuth client ID → Desktop app** and download its JSON.
5. Move it to the person's `gmail/credentials.json` (see paths below).
6. Run `python -u gmail_cli.py auth --no-browser` and drive consent in the
   controlled browser; `token.json` is written on success.

## Manual fallback (if you'd rather set it up yourself)

1. **Install the client libraries** (once per machine):

   ```
   python -m pip install -r requirements.txt
   ```

2. **Create an OAuth client** in Google Cloud Console:
   - Create/select a project and **enable the Gmail API**.
   - Configure the **OAuth consent screen** (External is fine; while it's in
     "Testing", add the person's Gmail address under **Test users**).
   - Create an **OAuth client ID** of type **Desktop app** and **download** the
     JSON.

3. **Drop the credentials next to the person's profile** as `credentials.json`:
   - Royce (default): `C:/Users/Royce/.pi/agent/job-search/gmail/credentials.json`
   - A named person:   `C:/Users/Royce/.pi/agent/job-search/<name>/gmail/credentials.json`

4. **Authorize** (opens a browser once; grant access):

   ```
   python gmail_cli.py auth                    # opens system browser
   python gmail_cli.py auth --no-browser       # prints AUTH_URL: <url> instead
   python gmail_cli.py --profile arthur auth
   ```

   This writes `token.json` beside `credentials.json` and reuses it afterwards
   (auto-refresh). Tokens/credentials are per-person so identities never mix.

## Scopes

- `gmail.modify` — read messages, mark read/unread, add/remove labels.
- `gmail.compose` — create drafts and send.

No permanent-delete scope is requested.

## Quick reference

```
python gmail_cli.py whoami
python gmail_cli.py search -q "application received" --newer-than 30d --max 20
python gmail_cli.py search --unread --newer-than 14d
python gmail_cli.py read --id <MSG_ID> --save-attachments ./oa
python gmail_cli.py thread --id <THREAD_ID>
python gmail_cli.py download --id <MSG_ID> --dir ./attachments
python gmail_cli.py draft --reply-to <MSG_ID> --body-file reply.txt   # review-first
python gmail_cli.py reply --id <MSG_ID> --body "..." --reply-all       # sends now
python gmail_cli.py send --to a@b.com --subject "Hi" --body "..."
python gmail_cli.py mark  --id <MSG_ID> --read
python gmail_cli.py label --id <MSG_ID> --add "Job Search"
```

Add `--json` to `whoami` / `search` / `read` / `thread` for machine-readable
output. Add `--profile <name>` (or `--data-dir <path>`) to any command to act
as another person.
