# Persistent Pi continuity

- Durable user-approved memory is stored in `~/ubuntu-pi/notes/CONTEXT.md`.
- When a task depends on prior goals, decisions, preferences, blockers, or progress, read that file before proceeding.
- When the user asks to save, sync, checkpoint, back up, remember, or preserve progress, use the `pi-context-sync` skill.
- Keep synchronization explicit: do not commit or push merely because a turn ended.
- Never place credentials, Pi authentication, private keys, hidden reasoning, tool data, or raw sessions in the persistence repository.

# Job-search skill - Ubuntu VM overrides (THIS MACHINE ONLY)

These rules apply only on this Ubuntu VM. They extend the shared `job-search`
skill and are intentionally NOT in the git-synced SKILL.md.

Storage here is limited, so DO NOT keep a library of tailored resume PDFs:
- Generate each application resume on the fly:
  - Arthur: python3 ~/.pi/agent/job-search/arthur/make_resume.py <tailor.json|-> <out.pdf>
  - Ivan:   python3 ~/.pi/agent/job-search/ivan/make_resume.py <tailor.json|-> <out.pdf>
  - Royce:  ~/.pi/agent/job-search/parallel/gen_resume.sh <swe|pm> <slug> "<summary>" (needs chromium)
- Upload that generated PDF to the application.
- AFTER the application is submitted (or you skip/abandon the posting), DELETE the
  generated PDF you just created. Do not accumulate per-job resumes on this VM.
- Keep permanently (never delete): each person profile.json, resume.md,
  applications.md, gmail/ tokens, the base resumes
  (arthur/resumes/Arthur_Base.pdf, ivan/resumes/Ivan_Vicente_Resume_Base.pdf),
  and the generators/templates (make_resume.py, parallel/gen_resume.sh,
  parallel/resumes/_base_swe.html and _base_pm.html).
- Name generated files predictably, e.g. resumes/<Name>_<Company>_<RoleSlug>.pdf,
  so cleanup after submit is unambiguous.
