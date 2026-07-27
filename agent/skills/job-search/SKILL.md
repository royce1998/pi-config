---
name: job-search
description: Help find jobs and apply to them by driving the browser. Use whenever the user wants to search for jobs, look at a job posting, fill out a job application, upload a resume, or track applications. Also checks and acts on job-application email via the Gmail API — confirm "application received" messages, take/forward assessments (OAs), and respond to recruiter requests for more info or scheduling. Works on any site (LinkedIn, Indeed, Greenhouse, Lever, Workday, and company career pages).
---

# Job search & application helper

You drive a real Chrome window (via the `browser_*` tools) to help the user find
and apply to jobs on any website. The user can see the window and take over at any time.

## Files (read/update these)

The base directory is `C:/Users/Royce/.pi/agent/job-search/`. It holds the **default (Royce's)**
profile plus one **subdirectory per additional person** the user helps (e.g. friends/family).
Each person's files live together and are kept separate so identities never mix.

- Default profile (Royce):
  - Profile:     `C:/Users/Royce/.pi/agent/job-search/profile.json`
  - Resume text: `C:/Users/Royce/.pi/agent/job-search/resume.md`
  - Tracker:     `C:/Users/Royce/.pi/agent/job-search/applications.md`
  - Gmail creds: `C:/Users/Royce/.pi/agent/job-search/gmail/{credentials,token}.json` (optional)
- Per-person profiles (a named subfolder, e.g. `arthur/`):
  - Profile:     `C:/Users/Royce/.pi/agent/job-search/<name>/profile.json`
  - Resume text: `C:/Users/Royce/.pi/agent/job-search/<name>/resume.md`
  - Tracker:     `C:/Users/Royce/.pi/agent/job-search/<name>/applications.md`
  - Resumes:     tailored PDFs in `C:/Users/Royce/.pi/agent/job-search/<name>/resumes/`
  - Gmail creds: `C:/Users/Royce/.pi/agent/job-search/<name>/gmail/{credentials,token}.json` (optional)
- Resume file for uploads: path is in that person's `profile.json` → `resumes.*.path`.
- Email helper: `C:/Users/Royce/.pi/agent/skills/job-search/scripts/gmail_cli.py` (see "Email
  (Gmail) integration").

**Figure out WHOSE application this is first.** If the user names a person (e.g. "help Arthur
 apply"), `ls` the base directory for a matching subfolder and use that person's files. If they
don't name anyone, default to the base `profile.json` (Royce). If a named person has no folder
yet, tell the user and offer to set one up — don't apply with someone else's identity.

**Before doing anything**, `read` the correct person's `profile.json`, `applications.md`, and
`resume.md`. If the profile is mostly empty (names/email blank), tell the user to fill it in first
and stop. Always read and update the tracker that lives beside the profile you're using — never
mix one person's applications into another's tracker.

## Golden rules

1. **Don't click the final "Submit"/"Send application" button unless the account owner has
   explicitly authorized you to submit on their behalf.** By default, fill everything, then STOP,
   summarize what you entered, and ask the user to review and submit — this keeps quality high,
   respects site terms, and protects the user's accounts. **Exception:** if the user has clearly
   told you to submit for them (e.g. "you can submit on my behalf"), you may click Submit — but
   verify every field carefully first, since there is no human review step, and wait for the
   confirmation page before logging. If unsure whether authorization still applies, ask.
2. **Batch actions on a stable form; re-snapshot only when the page actually changes.** Refs
   (`[e1]`, `[e2]`) stay valid until the DOM changes, so from a single `browser_snapshot` you can
   fire many `browser_fill` / `browser_set_checkbox` / `browser_choose` calls together (in one tool
   block) to fill a whole screen at once, then re-snapshot once to verify. Only re-`browser_snapshot`
   after navigation, an Apply/Next click, or anything that reloads or re-renders — not between every
   field.
3. **Never invent answers.** Only fill values you have from `profile.json`/`resume.md` or that
   the user gave you. If a required field has no source, list it and ask the user.
4. **Tailor, don't spam.** For cover letters and "why this role/company" questions, write a
   short, specific answer grounded in the posting and the user's resume — not a generic blurb.
5. **No duplicates; max 3 applications per company.** Before applying, check `applications.md`:
   never re-apply to a posting whose link is already listed, and never exceed 3 applications to
   the same company (case-insensitive; count subsidiaries under the parent, e.g. "Twilio (Stytch)"
   counts as Twilio). If either limit is already hit, tell the user and stop. The operational
   check is step 0 under "Applying to a posting."
6. If you encounter any robot checks or captchas, use the solve-captcha skill if exists.
7. **Never send email without authorization.** The Gmail integration lets you read freely, but
   treat sending like the final Submit button: by default **draft** a reply and stop for the user
   to review/send. Only send directly (`reply`/`send`) when the user has authorized it (see
   `authorization.mayEmail` in `profile.json`, or an explicit go-ahead). Reading, labeling, and
   marking messages read never need authorization.
8. **NEVER drive Gmail or any Google account with the browser/bot.** Automated web access to
   Gmail/Google (signing in, reading webmail, clicking through consent) gets the account **banned**.
   Access email ONLY through the Gmail API (`gmail_cli.py`). Any step on a `google.com` domain
   (sign-in, Cloud Console, OAuth consent/Allow) is **human-only** — hand it to the user. If the API
   isn't set up, email features are simply unavailable; do NOT fall back to the browser for email.

## When something unexpected happens (reason + proceed autonomously)

Applications never go exactly to script — forms break, widgets don't expose refs, an ATS throws an
error, a field is ambiguous, a step doesn't match this guide. When you hit an unexpected
problem or error, **be creative and reason it out; don't just stop or give up.**

1. **Diagnose before reacting.** Read what's actually on screen (`browser_snapshot` / `browser_read`,
   the exact error text, and one viewport `browser_screenshot` if a widget is invisible). Form a
   concrete hypothesis about the real cause instead of guessing blindly.
2. **Reason logically about options, then try the most sensible fix yourself.** Common moves: drive a
   stubborn widget by keyboard, re-`browser_snapshot` after a re-render, `browser_wait` for async
   content, reload or `browser_back` and retry, dismiss a blocking modal/cookie banner, go straight
   to the company's own ATS link instead of the aggregator, re-click Yes/No toggles that dropped,
   try a different resume variant or field value, or open a fresh tab. Prefer a truthful alternative
   path over abandoning the application.
3. **Proceed autonomously.** Pick the most reasonable option and keep going — especially in
   autonomous/parallel runs, do NOT idle waiting for input on a recoverable problem. Make the call,
   act, and note anything uncertain in the tracker notes.
4. **Stay within the rules while being resourceful:** never invent facts, submit without
   authorization, mislabel identity, duplicate an application, or answer a screening question
   dishonestly just to get past it.
5. **Only escalate to the human for genuine human-only blockers** — an unsolvable captcha / explicit
   "are you a human/AI?" attestation, an account or email you truly can't access, a required value
   with no source, or the final Submit when you aren't authorized. Log those (e.g. to
   `pending_ai_check.md`) and move on to the next role rather than stalling the whole run.

The goal: behave like a resourceful person who hits a snag, thinks it through, solves what they
reasonably can, and keeps making progress — escalating only what actually requires the user.

## Core loop for interacting with a page

1. `browser_snapshot` — get URL, title, and numbered interactive elements.
2. Decide the single next action.
3. Act with `browser_click` / `browser_fill` / `browser_set_checkbox` / `browser_upload` /
   `browser_press`, referencing a ref from the latest snapshot.
   - **Dropdowns matter:** use `browser_select` ONLY for a native `<select>`. For custom
     dropdowns / comboboxes / autocompletes (Greenhouse, Ashby, Lever, Workday, react-select,
     and Google-Places location fields — i.e. most modern ATS) use `browser_choose`, which opens
     the control, types to filter, and clicks the matching option in one step.
   - **Hidden radio/checkbox groups (Ashby especially):** some ATS render multi-choice questions
     ("select all that apply", single-choice radios, shift/skills lists) as custom widgets that do
     NOT appear as clickable refs in the snapshot. Drive them by keyboard: focus the last labeled
     control just before the group (pass its ref to `browser_press` "Tab"), press Tab to enter the
     group, then `ArrowDown`/`ArrowUp` to move (which also selects in a radio group) and `Space`
     to toggle a checkbox or select the focused option. Tab again to reach the next group. Always
     confirm with a `browser_screenshot`, since these selections are invisible in the snapshot.
     Note Ashby's "Autofill from resume" often pre-checks skill boxes it detects.
   - **Indeed "AI-tailored Indeed Resume" can FABRICATE credentials from your screener answers.**
     Example: answering "Yes" to "do you hold a Certified Medical Assistant credential" made Indeed
     add a "Certified Medical Assistant" certification to the tailored resume, which Arthur does
     NOT hold (he holds Registered Medical Assistant / RMA). ALWAYS review the AI-tailored resume
     before confirming: open each added Certification/License/Summary and fix or remove anything
     untrue (edit it to the real credential). Editing also fixes the saved Indeed Resume for future
     applies. For "Certified Medical Assistant" credential questions, remember RMA ≠ CMA; answer to
     the actual credential and let the resume show "Registered Medical Assistant".
   - **Ashby Yes/No toggle buttons can silently drop their selection on re-render.** These
     paired Yes/No pill buttons sometimes look selected but don't register, or get cleared when
     you interact with another field afterward. To avoid a failed submit: fill ALL text/number/
     upload/dropdown fields FIRST, click the Yes/No toggles LAST, then take one viewport
     screenshot to confirm every toggle is still highlighted, and submit immediately without
     touching other fields in between. If a submit returns "Missing entry for required field" for
     a Yes/No question, just re-click both toggles and resubmit in one pass.
   - **Read a dropdown's real options before choosing — don't guess the option label.** When the
     choices aren't obvious, open the control (click it, then `browser_snapshot` or
     `browser_screenshot`) to see the actual options, then select the exact matching label. Option
     wording is often non-obvious: an acknowledgement field's only choice may be "Acknowledge/
     Confirm" (not "Yes"); EEO veteran/disability options use specific legal phrasing. Guessing text
     with `browser_choose` silently fails or leaves the field blank when nothing matches, so verify
     after selecting.
4. The action returns a fresh snapshot — read it and repeat.
- Use `browser_read` to read long text like a job description.
- Use `browser_screenshot` when the text snapshot is ambiguous (custom widgets, visual layout).
- Use `browser_wait` after actions that load content async (Apply buttons, next-step transitions).
- If clicking Apply opens a new tab, use `browser_tabs` + `browser_switch_tab` to move to it.

## Screenshots — size & error safeguard (MANDATORY)

The model API **rejects any request where an image dimension exceeds 2000px** once several
images are in context (error: `image dimensions exceed max allowed size for many-image
requests: 2000 pixels`). A long application form screenshotted full-page is the usual culprit and
will kill the whole session. To make sure this never happens:

- **NEVER call `browser_screenshot` with `fullPage: true`** in this workflow. Full-page shots of
  long forms are far taller than 2000px and trigger the fatal error. Always use the default
  viewport screenshot (one screen high), and `browser_scroll` to see more.
- **Prefer `browser_snapshot` / `browser_read` over screenshots.** They carry no image-size risk.
  Only screenshot when a widget is genuinely invisible to the snapshot (hidden Ashby radios, custom
  canvases). The prior session died from screenshot overload — keep total screenshots low.
- **One screenshot at a time; don't stack many.** After you've read a screenshot and acted, you
  don't need to keep taking more of the same screen. Verify hidden-widget selections with a single
  viewport screenshot, not repeated full-page captures.
- If you ever see the `2000 pixels` / `many-image` error, stop screenshotting, rely on
  `browser_snapshot`, and continue — do not retry the same full-page capture.

## Working efficiently (speed)

Applications get slow when every field is its own snapshot → reason → act round-trip. Cut it down:

- **Fill in batches.** One `browser_snapshot`, then issue every `browser_fill` /
  `browser_set_checkbox` / `browser_choose` for that screen in a single tool block; re-snapshot
  once afterward to verify. A stable form doesn't change refs between text fills.
  Caveat: some React/ATS text inputs (notably Greenhouse) drop or misroute characters when fills
  fire too fast together, concatenating values into the wrong field (e.g. last name landing in the
  email box). If you see that, fall back to filling those inputs one at a time and verify each.
- **Read `profile.json` and `applications.md` once per session,** not once per job — reuse the values.
- **Go straight to the application.** Prefer the direct ATS/apply link (Greenhouse/Ashby/Lever)
  over clicking career-page → posting → Apply. Use `browser_fill(submit=true)` to combine typing a
  search query with Enter.
- **One dropdown call, not four.** Use `browser_choose` for custom dropdowns/locations instead of
  click → snapshot → fill → press.
- **Ask once, not per field.** If several fields have no source, collect them and ask the user in a
  single message rather than stopping at each one.
- **Skip optional work.** Don't screenshot unless the snapshot is ambiguous, and don't re-read a
  posting or re-fetch a file you already have.

## Finding jobs

- Ask the user for role, location/remote, and any target companies or sites (unless already given).
- Open the relevant search (`browser_open` with a URL, or navigate + fill the site's search box).
- Read results, then present a short shortlist (title, company, location, link) and let the user
  pick which to open. Don't mass-open or mass-apply.
- **Don't rely only on job boards (LinkedIn / Indeed / aggregators) — also go to companies' own
  career sites directly.** Many companies don't post everything (or anything) on the big boards;
  their own site (`https://<company>.com/careers`, or their ATS at `job-boards.greenhouse.io/<co>`,
  `jobs.ashbyhq.com/<co>`, `jobs.lever.co/<co>`) often has more, fresher, and exclusive roles. When
  the user names target companies, start with each company's own site.
- **Trust the source over an aggregator's tag.** Aggregator filters are noisy — a LinkedIn "Remote"
  card is frequently really hybrid/onsite, and its level filter mislabels roles. Always confirm
  location, seniority level, and posting date on the company's own posting before applying.
- **Honor the user's filters** (e.g. remote-only, recent postings, exclude "Senior/Staff/Principal/
  Lead" titles). Note many top-tier firms post remote roles at senior level only; to find recent
  mid-level remote roles you often need mid-tier companies and their own career sites.

## Applying to a posting

0. **Check the tracker first (dedupe + cap).** `read` `applications.md`, then:
   - **Duplicate posting:** if this posting's link already appears, don't re-apply — tell the
     user it's already tracked and stop.
   - **Per-company cap:** count rows whose Company matches this posting's company (case-insensitive;
     ignore suffixes like "Inc"/"LLC"; count subsidiaries under the parent). If there are already 3,
     stop and tell the user they've reached the 3-applications-per-company limit; do not proceed.
1. `browser_read` the posting; summarize key requirements for the user.
2. Find and click the Apply button; handle any multi-step flow one screen at a time.
3. Fill fields from `profile.json`, **batching all fills for the screen into one tool block** (see
   "Working efficiently"). Map common fields: name, email, phone, address, LinkedIn/GitHub,
   work authorization, sponsorship, salary, start date, "how did you hear", years of experience.
   - If `desiredSalary` is blank and salary is required, ask the user or reference the posting's
     published range — never invent a number. If `earliestStartDate` is blank, derive it from
     `noticePeriod` (e.g. "2 weeks" → about two weeks out). Leave optional blanks (GitHub, portfolio)
     empty rather than guessing.
4. For a resume upload, use `browser_upload` with the correct variant from `profile.json` → `resumes`:
   pick `softwareEngineer` for engineering roles, `productManagement` for product roles
   (see each variant's `useFor`). When unsure which, ask the user.
   - **Tailor the resume to EVERY application** (don't upload the same generic PDF to every job).
     Adjust the title/summary/skills to mirror the specific posting using only the applicant's real
     experience — never invent. If the person has a resume generator (e.g. Arthur's
     `make_resume.py <tailor.json> <out.pdf>`, or Royce's `parallel/gen_resume.sh`), write a small
     per-job tailor input and generate a fresh PDF named for the company+role
     (`resumes/<Name>_<Company>_<RoleSlug>.pdf`), then upload that. Facts (experience, education,
     references) stay fixed; only the title, summary, and skills emphasis change per posting.
5. **Answer every screening / "unexpected" question; never skip or leave them blank.** Beyond the
   standard fields, postings add custom questions: skills checklists ("select all that apply"),
   availability/shift, scenario/"describe a time" prompts, yes/no qualifiers. Read ALL the answer
   choices, then pick the option(s) that are truthful for the applicant AND maximize the chance of
   advancing:
   - Check every skill/tool/certification the applicant genuinely has (from `profile.json` skills +
     `resume.md`); leave only untrue ones unchecked.
   - For availability/schedule/relocation, choose the most favorable option the applicant can
     honestly commit to (per their preferences).
   - For scenario/open questions, write a short, specific, truthful answer grounded in `resume.md`
     that shows fit for this role.
   - Only answer honestly-unfavorably if there's no truthful favorable choice; never invent
     qualifications. Ask the user only if an honest answer could auto-reject and you're unsure.
6. For free-text (cover letter, "why you"), draft a tailored answer from `resume.md` + the posting.
   Use the SWE summary/framing for engineering roles and the PM framing for product roles.
   Show it to the user before entering it if it's substantial.
7. For demographic/EEO questions (gender, race/ethnicity, veteran status, disability status),
   use the person's `demographics_optional` values captured during setup. Use whatever real value
   the user provided; only fall back to "decline to self-identify" for a field they left blank.
   Never guess a value the user hasn't given.
8. When the form is complete: if the user authorized you to submit (Golden rule 1), verify every
   field, click Submit, wait for the confirmation/"thank you" page, then log it. Otherwise **STOP**,
   summarize every field you filled and any you skipped, and ask the user to review and click Submit
   themselves.

## After submission

- **If you submitted (authorized):** confirm you reached the confirmation / "thank you" page first,
  then log it.
- **If the user submits:** you won't see the click, so ask them to confirm they actually submitted,
  and only then log it.
- **Check for a confirmation email.** If Gmail is set up for this person, after logging you can
  `search -q "application" --newer-than 7d` (see "Email (Gmail) integration") to catch the
  "application received" mail and any immediate assessment/next-step request.

Append a row to the tracker beside the profile you're using (base
`C:/Users/Royce/.pi/agent/job-search/applications.md`, or the person's
`C:/Users/Royce/.pi/agent/job-search/<name>/applications.md`):
`| YYYY-MM-DD | Company | Role | Location | <link> | Applied | <notes> |`
Use today's date; in notes record the resume variant used and the comp range. Don't log an
application the user didn't submit.

## Email (Gmail) integration

**Always access job-application email through the `gmail_cli.py` CLI below — never by opening
Gmail/webmail in the browser.** Reading email in the browser is slower, brittle, and (for isolated
parallel-worker profiles) usually not even logged in. The CLI uses the person's own OAuth token, so
every session/worker can read and act on the inbox the same way. **If the CLI isn't set up yet for
this person (`whoami` fails with "No OAuth client found"), do the one-time OAuth setup below FIRST,
then use the CLI** for all confirmations, verification codes, assessments, and replies. The only time
you touch the browser for email is the initial consent click during that setup.

After applying, the follow-ups arrive by email: "application received" confirmations, online
assessment (OA) invites, recruiter questions, and interview scheduling. Use the Gmail helper to
read and act on the applicant's job-application inbox. It's a small Python CLI you drive with the
`bash` tool.

- **Script:** `C:/Users/Royce/.pi/agent/skills/job-search/scripts/gmail_cli.py`
- **Setup requires a Google OAuth client — and every google.com step is HUMAN-ONLY.** Never drive
  Gmail or any Google page (sign-in, Cloud Console, OAuth consent) with the browser/bot; automated
  access gets the account banned. The agent only does LOCAL steps (install libs, place
  `credentials.json`, run `gmail_cli.py auth`, then use the API). Ask the USER to perform every
  google.com step. If they can't/won't, Gmail features stay unavailable — do not work around it with
  the browser.
- **Whose inbox?** Same rule as the profile: default is Royce; pass `--profile <name>` (or
  `--data-dir <path>`) to act as another person. Always match the inbox to the profile you're using.
  Secrets live PER PERSON so identities never mix:
  - Royce (default): `C:/Users/Royce/.pi/agent/job-search/gmail/{credentials,token}.json`
  - Named person:    `C:/Users/Royce/.pi/agent/job-search/<name>/gmail/{credentials,token}.json`

### First-time setup (the user does the Google steps)

Only needed once per account (skip if `whoami` already works). The Gmail API requires an OAuth
client the account owns. **Do NOT automate any google.com page with the browser — Google bans
accounts for bot activity.** Give the user the deep links below and have THEM click through in their
own browser; the agent only handles the local files and the `gmail_cli.py` commands.

1. **Install libs** (once per machine): `python -m pip install -r
   C:/Users/Royce/.pi/agent/skills/job-search/scripts/requirements.txt`
2. **Create/select a project** — open `https://console.cloud.google.com/projectcreate`, name it
   e.g. `job-search`, Create, and wait for it to become the active project.
3. **Enable the Gmail API** — open
   `https://console.cloud.google.com/apis/library/gmail.googleapis.com` and click **Enable**
   (confirm the right project is selected in the top bar).
4. **Configure the consent screen (Google Auth Platform)** — open
   `https://console.cloud.google.com/auth/branding`. If it shows **Get started**, run the wizard:
   App name = `job-search`, user support email = the user's address, **Audience = External**,
   contact email = the user's address, agree, Finish/Create.
5. **Add the user as a test user** — open `https://console.cloud.google.com/auth/audience`; under
   **Test users** click **Add users**, enter the user's Gmail address, Save. (Required while the app
   is in "Testing" so consent isn't blocked.)
6. **Create the OAuth client** — open `https://console.cloud.google.com/auth/clients`, click
   **Create client** (or Credentials → Create credentials → OAuth client ID), choose
   **Application type = Desktop app**, name it `job-search cli`, Create. In the dialog, click
   **Download JSON** (or Download OAuth client). It lands in the Downloads folder.
7. **Move it into place** as `credentials.json` beside the profile (create the `gmail/` folder):
   ```
   mkdir -p "C:/Users/Royce/.pi/agent/job-search/gmail"
   mv "$(ls -t /c/Users/Royce/Downloads/client_secret_*.json | head -1)" \
      "C:/Users/Royce/.pi/agent/job-search/gmail/credentials.json"
   ```
   (For a named person use `.../job-search/<name>/gmail/credentials.json`.)
8. **Authorize (the USER drives consent in their own browser).** From the scripts dir run
   `python -u gmail_cli.py auth --no-browser > auth.log 2>&1 &`, wait ~2s, read `auth.log`, grep the
   `AUTH_URL:` line, and give that URL to the user to open themselves. They complete consent (pick
   the account; on "Google hasn’t verified this app" click **Advanced → Go to job-search (unsafe)**;
   then **Allow**). The backgrounded process writes `token.json`; confirm with
   `python gmail_cli.py whoami`. **The agent must never type Google credentials or click through
   Google consent in the automated browser.** Then update `profile.json` → `gmail.enabled = true`.

If any step is genuinely blocked (e.g. the account can't create GCP projects, or org policy forbids
it), tell the user exactly what's blocking and what you need from them — by anti-ban policy ALL
google.com steps (sign-in, Cloud Console, consent/Allow) are human-only; never automate them in the
browser as a workaround.

Run from the scripts dir (`cd C:/Users/Royce/.pi/agent/skills/job-search/scripts`). Add `--json`
to `search`/`read`/`thread`/`whoami` for machine-readable output; add `--profile <name>` for others.

| Need | Command |
|------|---------|
| Confirm auth / which account | `python gmail_cli.py whoami` |
| Find recent job email | `python gmail_cli.py search -q "application" --newer-than 30d --max 25` |
| Unread follow-ups | `python gmail_cli.py search --unread --newer-than 14d` |
| From a specific company | `python gmail_cli.py search --from "@greenhouse.io" --newer-than 30d` |
| Read one message (+ links, attachments) | `python gmail_cli.py read --id <MSG_ID> --save-attachments ./oa` |
| Read a whole thread | `python gmail_cli.py thread --id <THREAD_ID>` |
| Save attachments | `python gmail_cli.py download --id <MSG_ID> --dir ./attachments` |
| Draft a reply (review-first) | `python gmail_cli.py draft --reply-to <MSG_ID> --body-file reply.txt` |
| Send a reply (authorized only) | `python gmail_cli.py reply --id <MSG_ID> --body "..." --reply-all` |
| Send new email (authorized only) | `python gmail_cli.py send --to a@b.com --subject "..." --body "..."` |
| Send a draft you made | `python gmail_cli.py send-draft --id <DRAFT_ID>` |
| Mark read / label | `python gmail_cli.py mark --id <MSG_ID> --read` · `label --id <MSG_ID> --add "Job Search"` |

`search` and `read` auto-tag each message to help you triage: **received** (application
acknowledged), **assessment** (OA/coding test/take-home), **schedule** (wants availability /
Calendly / phone screen), **info-request** (needs more info/forms), **rejection**. `read` also
extracts URLs and lists/saves attachments. These tags are hints — always read the message to
confirm before acting.

### Follow-up flows

1. **Check application confirmations.** After a batch of applies, `search -q "application"
   --newer-than 14d`. Match "received/thanks for applying" mails to rows in `applications.md`; if a
   confirmation arrived, you may note it (e.g. `Status: Applied ✓ confirmed`). If a company you
   applied to has no confirmation after a few days, mention it — the application may not have gone
   through.
2. **Assessments / OAs.** For an **assessment**-tagged mail, `read` it, capture the platform link
   (HackerRank/Codility/CodeSignal/etc.) and the deadline, and save any attached take-home. Then
   drive the assessment in the browser using the normal `browser_*` loop (open the link, log in if
   needed, work through it). Coding/skills tests are the applicant's own work: **do the parts you
   legitimately can, but surface timed/proctored or knowledge-check tests to the user rather than
   impersonating them on an evaluation.** When unsure, summarize the assessment and ask how they
   want to proceed. Log the OA in the tracker notes with its deadline.
3. **Requests for more info.** For **info-request** mails (work authorization, references,
   a questionnaire, availability, desired salary), answer from `profile.json` / `resume.md` exactly
   as you would a form field — never invent. Draft the reply (`draft --reply-to`), show it to the
   user, and only `reply`/`send-draft` if authorized (Golden rule 7). If the request is a web form,
   open its link and fill it in the browser instead.
4. **Scheduling.** For **schedule** mails, read the proposed times / booking link. If it's a
   Calendly/Greenhouse link, open it in the browser and pick a slot consistent with the user's
   stated availability (ask if you don't have it). If it's free-text ("what times work?"), draft a
   reply proposing times from the user's availability and let them confirm/send.
5. **Rejections.** Update the tracker row's Status to `Rejected` (note the date). Don't reply
   unless the user asks.

After you read/handle a message, you can `mark --read` and/or `label --add "Job Search"` to keep the
inbox triaged. Record meaningful outcomes (OA received, interview scheduled, rejected) in the
tracker notes so the two stay in sync.

### Forwarding filters (auto-forward important mail to another address)

The user may want the applicant's job-search Gmail to **auto-forward important emails** (e.g. ones
containing `interview`, `offer`, `schedule`, `zoom`, `availability`, `accepted`, `call`, `available`)
to a second address they check more often (e.g. a school/work inbox). Do this through the **Gmail
API only** — never touch Gmail Settings in the browser (anti-ban policy, Golden rule 8).

**Extra OAuth scopes are required** beyond `gmail_cli.py`'s `modify`+`compose`:
- `gmail.settings.basic` — create/list **filters**
- `gmail.settings.sharing` — register a **forwarding address** (a restricted scope)

Because of that, forwarding setup uses a **separate helper with its own token** so it never
disturbs the job-search CLI's `token.json`:
- Helper: `C:/Users/Royce/.pi/agent/job-search/<name>/gmail/gmail_forward_setup.py`
- Token:  `.../gmail/token_settings.json` (settings scopes), reusing the same `credentials.json`.

Two steps are **human-only** (all google.com consent is human-only): approving the new scopes, and
(if the destination isn't already verified) clicking the verification link Gmail emails to it.

Flow:
1. **Re-consent for the settings scopes.** From the person's `gmail/` dir run
   `python -u gmail_forward_setup.py auth --no-browser > auth_forward.log 2>&1 &`, wait ~3s, `cat`
   the log, and give the `AUTH_URL:` line to the USER to approve in their own browser (Advanced →
   Go to … (unsafe) → check the mail-settings boxes → Allow). Writes `token_settings.json`.
2. **Register the forwarding address (if needed).** `python gmail_forward_setup.py list-forward`
   first — Gmail may already list the destination as `accepted` (then skip this). Otherwise
   `python gmail_forward_setup.py add-forward <dest@addr>`; Gmail emails a verification link to
   `<dest@addr>` — the USER opens that inbox and clicks it, then re-run `list-forward` until it
   shows `accepted`. (Note: `forwardingAddresses.create` via user OAuth can 403 with
   "restricted to service accounts" — if `list-forward` already shows the address `accepted`, ignore
   that error and proceed to the filter.)
3. **Create the filter** once the destination is `accepted`. Prefer a **phrase-based** query over
   bare common words — this inbox is job-dedicated, so the goal is surfacing the *actionable* mail
   (interview invites, screens, scheduling, offers, assessments, next steps), NOT every "thanks for
   applying" ack, rejection, or job-alert digest. Single words like `call`/`available`/`schedule`
   are weak; quoted phrases like `"phone screen"`, `"next steps"`, `"schedule a call"` are far
   higher-signal. Pass a raw Gmail query with `--query` (supports quotes, parentheses, and `-`
   negation) for full control, or `--terms "a,b,c"` for a simple OR of keywords (add
   `--subject-only` to match the Subject line only). A good recommended query:
   ```
   python gmail_forward_setup.py create-filter --to <dest@addr> --query \
   '(interview OR interviews OR interviewing OR "phone screen" OR "phone interview" OR "video interview" OR screening OR screen OR recruiter OR "hiring manager" OR "hiring team" OR "talent acquisition" OR offer OR "offer letter" OR "job offer" OR onsite OR "on-site" OR "next step" OR "next steps" OR "move forward" OR "moving forward" OR availability OR "your availability" OR "schedule a call" OR "schedule a time" OR "set up a time" OR "set up a call" OR "find a time" OR "book a time" OR "would like to schedule" OR "invite you" OR "invitation to interview" OR Calendly OR zoom OR "google meet" OR "microsoft teams" OR "video call" OR assessment OR "coding challenge" OR "take-home" OR "take home" OR "online assessment" OR HackerRank OR Codility OR CodeSignal OR accepted OR congratulations OR "speak with you" OR "chat with you" OR "meet with you" OR "connect with you" OR "look forward to speaking" OR "next round" OR "final round" OR "background check" OR references OR "reference check") -"job alert" -"jobs for you" -"recommended jobs" -"new jobs matching" -"jobs you may"'
   ```
   Wrap the OR list in parentheses so trailing `-"..."` negatives (which cut LinkedIn/Indeed job-
   alert digests) apply to the whole group. Verify with `list-filters`; remove one with
   `delete-filter --id <id>`. Forwarding keeps the message in the inbox (it isn't deleted). Use ONE
   comprehensive filter rather than several forward filters, so a message that matches multiple
   rules isn't forwarded more than once.

**Tune to taste:** if it still forwards too much, switch noisy bare words to phrases, add more
`-"..."` negatives, or use `--subject-only`. If it misses things, add sender-based intent later
(e.g. keep phrases but broaden). Common words like `call`, `available`, `schedule`, `offer` in a
whole-message match will over-forward — lean on quoted phrases instead.

### Organizing the inbox with labels/folders + priority handling

Beyond forwarding, the user may want the inbox *organized into folders* and destructive tidy-up
(auto-delete rejections). Gmail "folders" are **labels**; a filter can add labels, star, mark
important, archive (skip Inbox), mark read, or Trash. The helper exposes these as flags on
`create-filter`: `--star`, `--important`, `--add-label "Name"` (repeatable; `"Parent/Child"` makes a
nested folder; auto-created via the `gmail.modify` `token.json`), `--trash`, `--archive`,
`--mark-read`. Gmail allows **only ONE user label per filter** (STARRED/IMPORTANT are system labels
and don't count) — if you need a message in several folders, use one nested sub-label per filter and
rely on STARRED for a unified view; "Too many user labels in filter" means you passed >1 user label.

**Non-negotiable safety rule: good news is NEVER filtered out.** Interview/offer/question mail must
always be **forwarded + starred**, never trashed or archived-away. So every *destructive* filter
(Trash for rejections, Archive for confirmations) must carry a **guard** — a trailing set of
`-"..."` negatives for all strong positive signals (offer, interview, phone screen, screening,
congratulations, extend an offer, Calendly, schedule a call/time, next round/final round, your
availability, welcome to the team, …). When an email is ambiguous, it is forwarded, never deleted.
Keep the same guard string in a shell var and append it to both the rejection and the
applications-sent filters.

The standard job-inbox layout (all forward to the person's external address, matched by phrase
queries as above):

| Folder / action | Filter | Actions |
|---|---|---|
| `Priority Emails/Offers` | offer/comp/"pleased to offer"/congratulations phrases | forward + `--star --important` |
| `Priority Emails/Interviews` | interview/screen/schedule/Calendly/zoom phrases | forward + `--star` |
| `Priority Emails/Assessments` | assessment/OA/HackerRank/Codility/HireVue phrases | forward + `--star` |
| `Priority Emails/Questions` | "a few questions"/"please provide"/references/background-check phrases | forward + `--star` |
| `Applications Sent` | "thank you for applying"/"application received"/"successfully submitted" | `--add-label` + `--archive`, **guarded** (skip if good-news or rejection terms present) |
| (Trash) | "unfortunately"/"other candidates"/"regret to inform"/"not moving forward"/"position has been filled" | `--trash`, **guarded** by the good-news negatives |

Use ONE filter per category (a message that matches two good-news filters simply forwards twice —
harmless, and the safe error given "never miss good news"). `STARRED` unifies all priority mail into
Gmail's Starred view; the nested `Priority Emails/*` labels give per-type folders. Verify with
`list-filters`; the person's own Gmail account applies these server-side to new mail only (existing
mail is untouched unless the user asks to backfill).

## Applying at scale — parallel workers

When the user wants many applications fast ("spin up N workers", "apply to 150 jobs in parallel"),
use the **`parallel_apply`** tool (or the `/parallel` command) from the *supervisor* extension. It
launches up to **10** worker agents, each in its own child `pi` process with its **own isolated
Chrome profile**, and supervises them together until a shared progress goal is reached.

**Why a tool and not just launching many `pi` by hand:** Chrome allows only one process per
user-data-dir, so multiple workers on the *same* profile collide on the profile singleton lock and
only one browser works. `parallel_apply` gives each worker a unique `PI_BROWSER_PROFILE_DIR`
(`<cwd>/.parallel-profiles/worker-NN`) so they never collide, and clears any stale Chrome lock left
by a crashed worker.

Rules for a parallel run:

1. **Disjoint shards.** Give one shard string per worker, each a non-overlapping slice of the work
   (by role-type + geography, or by company). No two workers should ever apply to the same company;
   if a role fits two lanes, the lower-numbered worker owns it and the other skips it.
2. **Per-worker tracker files (avoid append races).** Ten workers appending to one
   `applications.md` at once will interleave and corrupt rows. Each worker records confirmed
   submissions to its OWN file `applications.wNN.md` (same table columns). **Dedupe** by re-reading
   `applications.md` + all `applications.w*.md` before applying. Merge the per-worker files back into
   `applications.md` when the run ends.
3. **Global progress + target.** `progressCommand` counts total applied rows across all trackers,
   e.g. `cat applications.md applications.w*.md 2>/dev/null | grep -c '| Applied |'`, and `target`
   is the grand total to reach (existing rows count toward it). The first worker to hit the target
   stops the whole group; workers that make no progress for `stallLimit` rounds stop on their own.
4. **Apply on companies' own ATS; avoid shared logins.** Isolated worker profiles are NOT logged
   into LinkedIn/portals, and using one account from 10 browsers trips security. Have workers apply
   on Ashby/Greenhouse/Lever/Workday/iCIMS/school portals (account signup + Gmail self-verify is
   fine); use LinkedIn/Indeed only to *discover* postings, not Easy Apply.
5. **Tailor every application** and **honor human gates** exactly as in the single-worker flow
   (captcha / "are you human/AI?" → fill everything else, don't submit, log to `pending_ai_check.md`,
   move on). Workers use the best model (e.g. `claude-opus-4.8:xhigh`); stagger launches
   (`staggerMs`) so 10 Chrome windows don't open at once.

Example (`/parallel`, abbreviated):

```
/parallel {"shards":["REMOTE admin-assistant roles … append to ./applications.w01.md",
"SEATTLE front-desk roles … append to ./applications.w02.md", …],
"progressCommand":"cat applications.md applications.w*.md 2>/dev/null | grep -c '| Applied |'",
"target":150,"cwd":"~/.pi/agent/job-search/arthur","model":"claude-opus-4.8:xhigh"}
```

When the run finishes, merge each `applications.wNN.md` into `applications.md`, report the totals,
and hand back any `pending_ai_check.md` items (they need the user to clear a human gate).

## Handy entry points

- LinkedIn jobs:  https://www.linkedin.com/jobs/
- Indeed:         https://www.indeed.com/
- If the user names a company, try `https://<company>.com/careers` or search for its jobs page.

## First-time setup note

Logins persist in a dedicated Chrome profile. The first time the user visits a site that needs
sign-in, ask them to log in once in the visible window; it will be remembered next time.

## VPN

If a VPN is available in the browser, use it when it helps — e.g. a posting is geo-restricted to a
country/region, an ATS or job board blocks or rate-limits the current IP, or an anti-bot gate
(captcha/"unusual traffic") keeps triggering. Prefer a region that matches the job's country (and,
when sensible, the applicant's location). Turn it off again if a site misbehaves behind the VPN.

- **This computer:** Surfshark VPN is installed as a Chrome extension. Open it from the Chrome
  toolbar / extensions menu, connect to an appropriate location, then retry the page. If the
  extension needs sign-in, ask the user to log in once in the visible window (it will persist).

## Profile setup checklist (collect these up front)

When setting up a new person's `profile.json` (base or a `<name>/` subfolder), collect the fields
below during setup so applications never stall waiting on them mid-form. Use Royce's
`profile.json` as the schema/template. Ask for real values; don't leave them to be discovered and
corrected later during an application.

- **Identity & contact:** legal first/last name, preferred name, email (a dedicated Gmail the agent
  can self-verify with is ideal), phone, full mailing address.
- **Gmail access (recommended):** connect the applicant's job-search Gmail so you can track
  confirmations, assessments, and recruiter follow-ups. **You set this up by driving the browser**
  (see "Email (Gmail) integration" → "First-time setup (you do this)"): create the OAuth client in
  Google Cloud Console and complete consent in the Chrome window yourself; the user only signs into
  Google. Also capture `authorization.mayEmail` — whether the agent may send/reply directly, or must
  draft only.
- **Work authorization (VERIFY — auto-reject fields):** authorized to work in country? require
  sponsorship? citizenship, security clearance.
- **Preferences:** target titles, locations / remote, willing to relocate, earliest start date /
  notice period, desired salary, employment types.
- **Resumes:** path(s) to the resume file variant(s) and which roles each is `useFor`.
- **Demographics / EEO (`demographics_optional`) — ALWAYS ask during setup**, because most ATS
  (Greenhouse, Lever, Workday, iCIMS) request them and a wrong default (e.g. auto-"decline") can be
  awkward to fix mid-application. Collect the person's actual answers, or an explicit "prefer not to
  say" per field:
  - `gender`
  - `race` / `raceDetail` (race & ethnicity)
  - `veteranStatus` (e.g. "I am not a protected veteran" / "I am a protected veteran" / prefer not to say)
  - `disabilityStatus` (e.g. "No, I do not have a disability" / "Yes…" / prefer not to say)
  - `transgender`, `sexualOrientation` (default to "I don't wish to answer" unless provided)
- **Common answers:** how did you hear, years of experience, 18+?, felony, referred by.
- **Submit authorization:** whether the user authorizes the agent to click final Submit on their
  behalf (`authorization.maySubmit`), and whether the agent may send email directly vs. draft-only
  (`authorization.mayEmail`).
