# pi-browser

Site-agnostic browser control for pi, built for a job-search helper (but general purpose).

- Drives your **installed Chrome** (`channel: "chrome"`) via `playwright-core` — no bundled browser download.
- Uses a **persistent profile** at `~/.pi/agent/job-search/browser-profile`, so logins to LinkedIn,
  company portals, etc. stick between runs. The window is **visible** so you can watch, log in,
  solve CAPTCHAs, and click the final Submit yourself.
- Works on **any page** via an accessibility snapshot: interactive elements get stable refs
  (`[e1]`, `[e2]`, …) that the model clicks/fills by ref — including inside **iframes**
  (Greenhouse / Workday embeds).

## Tools

`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`,
`browser_fill`, `browser_select`, `browser_set_checkbox`, `browser_upload`, `browser_press`,
`browser_scroll`, `browser_screenshot`, `browser_wait`, `browser_tabs`, `browser_switch_tab`,
`browser_back`.

Command: `/browser-close` closes the window.

## Related files

- Workflow skill: `~/.pi/agent/skills/job-search/SKILL.md`
- Your data:      `~/.pi/agent/job-search/{profile.json,resume.md,applications.md}`

## Notes

- Requires Google Chrome installed (found at the default path on this machine).
- The browser launches lazily on first tool use and closes on session shutdown or `/browser-close`.
- To reset stored logins, delete `~/.pi/agent/job-search/browser-profile`.
