#!/usr/bin/env python3
"""gmail_cli.py — a small Gmail helper for the job-search skill.

The job-search agent shells out to this script (via the `bash` tool) to read and
act on a person's job-application email: confirm "application received" messages,
detect assessment / OA invites (HackerRank, Codility, CodeSignal, etc.), spot
recruiter follow-ups asking for more info or to schedule, download attachments,
and send or draft replies.

It authenticates with the Gmail API using an OAuth "Desktop app" client. Secrets
are stored PER PERSON next to that person's profile so identities never mix:

    <data-dir>/gmail/credentials.json   # OAuth client you download from Google
    <data-dir>/gmail/token.json         # created on first `auth`, then reused

where <data-dir> defaults to  C:/Users/Royce/.pi/agent/job-search  (Royce), or
  C:/Users/Royce/.pi/agent/job-search/<name>  when you pass  --profile <name>.

Scopes requested: gmail.modify (read + label/mark) and gmail.compose (drafts +
send). No permanent-delete capability is requested.

Usage examples (run with the machine's `python`):
    python gmail_cli.py auth
    python gmail_cli.py whoami
    python gmail_cli.py search --query "application received" --max 15
    python gmail_cli.py search --unread --newer-than 14d --max 30
    python gmail_cli.py read --id 1901ab... --save-attachments ./oa
    python gmail_cli.py thread --id 1901ab...
    python gmail_cli.py download --id 1901ab... --dir ./attachments
    python gmail_cli.py draft --reply-to 1901ab... --body-file reply.txt
    python gmail_cli.py reply --id 1901ab... --body "Thanks, ..." --reply-all
    python gmail_cli.py send --to a@b.com --subject "Hi" --body "..."
    python gmail_cli.py mark --id 1901ab... --read
    python gmail_cli.py label --id 1901ab... --add "Job Search"

Add  --profile <name>  (or  --data-dir <path>)  to any command to act as another
person. Add  --json  to search/read/thread/whoami for machine-readable output.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
from email.message import EmailMessage
from pathlib import Path

def _default_base_dir() -> Path:
    # Explicit override for non-standard layouts.
    env = os.environ.get("JOB_SEARCH_DIR")
    if env:
        return Path(env)
    # The job-search DATA dir lives at <pi-home>/agent/job-search, while this
    # script lives at <pi-home>/agent/skills/job-search/scripts/gmail_cli.py.
    # Derive it from this file so the CLI is portable across machines and OSes
    # (Windows dev box, Linux VM, etc.) with no hardcoded per-machine path.
    try:
        derived = Path(__file__).resolve().parents[3] / "job-search"
        if derived.exists():
            return derived
    except (IndexError, OSError):
        pass
    # Legacy fallback (original Windows dev path).
    return Path("C:/Users/Royce/.pi/agent/job-search")


DEFAULT_BASE_DIR = _default_base_dir()

# Read + modify (labels, mark read/unread) and compose (create drafts, send).
# gmail.compose covers sending; gmail.modify covers reading and labels. Neither
# grants permanent delete.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
]

MISSING_LIBS_MSG = (
    "Gmail client libraries are not installed. Install them once with:\n"
    "    python -m pip install -r \"{req}\"\n"
    "(or: python -m pip install google-api-python-client google-auth "
    "google-auth-oauthlib)"
)


# --------------------------------------------------------------------------- #
# Paths & auth
# --------------------------------------------------------------------------- #
def resolve_data_dir(args) -> Path:
    if getattr(args, "data_dir", None):
        return Path(args.data_dir)
    if getattr(args, "profile", None):
        return DEFAULT_BASE_DIR / args.profile
    return DEFAULT_BASE_DIR


def gmail_dir(args) -> Path:
    d = resolve_data_dir(args) / "gmail"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _require_libs():
    try:
        from google.oauth2.credentials import Credentials  # noqa: F401
        from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: F401
        from google.auth.transport.requests import Request  # noqa: F401
        from googleapiclient.discovery import build  # noqa: F401
    except ImportError:
        req = Path(__file__).with_name("requirements.txt")
        sys.exit(MISSING_LIBS_MSG.format(req=req))


def get_service(args, *, interactive_ok=True):
    """Return an authorized Gmail API service, refreshing/creating token as needed."""
    _require_libs()
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    gdir = gmail_dir(args)
    token_path = gdir / "token.json"
    creds_path = gdir / "credentials.json"

    creds = None
    if token_path.exists():
        # Load with the token's OWN granted scopes (do NOT force SCOPES here).
        # A read-only token (e.g. Royce's gmail.readonly) would otherwise send
        # modify+compose on refresh and fail with invalid_scope. New consents
        # still request the full SCOPES via the auth flow below.
        creds = Credentials.from_authorized_user_file(str(token_path))

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not creds_path.exists():
                sys.exit(
                    "No OAuth client found.\n"
                    f"  Expected: {creds_path}\n\n"
                    "Set it up once:\n"
                    "  1. In Google Cloud Console, enable the Gmail API for a project.\n"
                    "  2. Create an OAuth client ID of type 'Desktop app'.\n"
                    "  3. Download its JSON and save it to the path above as "
                    "credentials.json.\n"
                    "  4. Add the person's Gmail address as a test user on the "
                    "OAuth consent screen (if the app is in 'Testing').\n"
                    "Then run:  python gmail_cli.py auth"
                )
            if not interactive_ok:
                sys.exit(
                    "Not authorized yet and this command can't open a browser. "
                    "Run  python gmail_cli.py auth  first."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
            open_browser = not getattr(args, "no_browser", False)
            # run_local_server binds a loopback port and captures the OAuth
            # redirect. With open_browser=True it also launches the system
            # default browser. With --no-browser it just prints the consent URL
            # (prefixed "AUTH_URL:") so an agent can drive consent in the Chrome
            # window it already controls, then this call returns once the
            # redirect lands on the loopback port.
            creds = flow.run_local_server(
                port=0,
                prompt="consent",
                open_browser=open_browser,
                authorization_prompt_message="AUTH_URL: {url}",
                success_message=(
                    "Authorized. You can close this tab and return to the agent."
                ),
            )
        token_path.write_text(creds.to_json(), encoding="utf-8")

    return build("gmail", "v1", credentials=creds, cache_discovery=False)


# --------------------------------------------------------------------------- #
# MIME parsing helpers
# --------------------------------------------------------------------------- #
def _header(headers, name):
    name = name.lower()
    for h in headers or []:
        if h.get("name", "").lower() == name:
            return h.get("value", "")
    return ""


def _b64d(data: str) -> bytes:
    return base64.urlsafe_b64decode(data.encode("utf-8"))


def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = re.sub(r"(?i)</p>", "\n\n", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    text = re.sub(r"[ \t]+", " ", html)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    # unescape a few common entities
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                 ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    return text.strip()


def _walk_parts(payload):
    """Yield every MIME part (including the root) flattened."""
    stack = [payload]
    while stack:
        part = stack.pop()
        yield part
        for sub in part.get("parts", []) or []:
            stack.append(sub)


def extract_body(payload) -> str:
    """Return the best-effort plain-text body of a message payload."""
    plain, html = None, None
    for part in _walk_parts(payload):
        mime = part.get("mimeType", "")
        body = part.get("body", {}) or {}
        data = body.get("data")
        if not data:
            continue
        if mime == "text/plain" and plain is None:
            plain = _b64d(data).decode("utf-8", "replace")
        elif mime == "text/html" and html is None:
            html = _b64d(data).decode("utf-8", "replace")
    if plain and plain.strip():
        return plain.strip()
    if html:
        return _html_to_text(html)
    return ""


def list_attachments(payload):
    out = []
    for part in _walk_parts(payload):
        filename = part.get("filename")
        body = part.get("body", {}) or {}
        if filename and (body.get("attachmentId") or body.get("data")):
            out.append({
                "filename": filename,
                "mimeType": part.get("mimeType", ""),
                "size": body.get("size", 0),
                "attachmentId": body.get("attachmentId"),
                "data": body.get("data"),  # present for small inline parts
            })
    return out


def find_links(text: str, limit=25):
    urls = re.findall(r"https?://[^\s>)\]\"']+", text or "")
    seen, out = set(), []
    for u in urls:
        u = u.rstrip(".,);")
        if u not in seen:
            seen.add(u)
            out.append(u)
        if len(out) >= limit:
            break
    return out


# Heuristics so the agent can triage at a glance.
ASSESSMENT_HINTS = (
    "hackerrank", "codility", "codesignal", "coderpad", "leetcode", "hackerearth",
    "testgorilla", "karat", "coderbyte", "assessment", "coding challenge",
    "online assessment", "take-home", "take home", "coding test", "skills test",
    "complete the test", "your test", "invite you to complete",
)
SCHEDULE_HINTS = (
    "schedule", "availability", "calendly", "book a time", "interview",
    "pick a time", "phone screen", "available times", "when are you free",
    "greenhouse.io/scheduling", "savvycal", "hire.withgoogle",
)
RECEIVED_HINTS = (
    "application received", "thanks for applying", "thank you for applying",
    "we received your application", "received your application",
    "application has been received", "successfully applied", "we got your application",
)
INFO_REQUEST_HINTS = (
    "please provide", "please complete", "fill out", "we need", "additional information",
    "work authorization", "reference", "questionnaire", "please confirm",
    "please reply", "could you send", "please share",
)
REJECTION_HINTS = (
    "unfortunately", "not moving forward", "decided not to proceed", "other candidates",
    "will not be moving", "unable to offer", "not be progressing", "won't be moving",
)


def classify(subject: str, body: str):
    text = f"{subject}\n{body}".lower()
    tags = []
    if any(h in text for h in ASSESSMENT_HINTS):
        tags.append("assessment")
    if any(h in text for h in SCHEDULE_HINTS):
        tags.append("schedule")
    if any(h in text for h in RECEIVED_HINTS):
        tags.append("received")
    if any(h in text for h in INFO_REQUEST_HINTS):
        tags.append("info-request")
    if any(h in text for h in REJECTION_HINTS):
        tags.append("rejection")
    return tags


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def _msg_meta(service, msg_id, fmt="metadata", headers=None):
    kwargs = {"userId": "me", "id": msg_id, "format": fmt}
    if fmt == "metadata" and headers:
        kwargs["metadataHeaders"] = headers
    return service.users().messages().get(**kwargs).execute()


def cmd_auth(args):
    get_service(args)  # triggers the flow / refresh
    svc = get_service(args, interactive_ok=False)
    prof = svc.users().getProfile(userId="me").execute()
    print(f"Authorized as {prof.get('emailAddress')}")
    print(f"Token stored in {gmail_dir(args) / 'token.json'}")


def cmd_whoami(args):
    svc = get_service(args, interactive_ok=False)
    prof = svc.users().getProfile(userId="me").execute()
    if args.json:
        print(json.dumps(prof, indent=2))
    else:
        print(f"Email:  {prof.get('emailAddress')}")
        print(f"Total messages: {prof.get('messagesTotal')}")
        print(f"Total threads:  {prof.get('threadsTotal')}")


def cmd_search(args):
    svc = get_service(args, interactive_ok=False)
    q = args.query or ""
    if args.unread:
        q = (q + " is:unread").strip()
    if args.newer_than:
        q = (q + f" newer_than:{args.newer_than}").strip()
    if args.from_addr:
        q = (q + f" from:{args.from_addr}").strip()
    if args.label:
        q = (q + f" label:{args.label}").strip()

    resp = svc.users().messages().list(
        userId="me", q=q or None, maxResults=args.max,
        labelIds=None,
    ).execute()
    ids = [m["id"] for m in resp.get("messages", [])]

    rows = []
    want = ["From", "Subject", "Date", "To"]
    for mid in ids:
        m = _msg_meta(svc, mid, "metadata", want)
        headers = m.get("payload", {}).get("headers", [])
        subject = _header(headers, "Subject")
        snippet = m.get("snippet", "")
        tags = classify(subject, snippet)
        rows.append({
            "id": mid,
            "threadId": m.get("threadId"),
            "date": _header(headers, "Date"),
            "from": _header(headers, "From"),
            "subject": subject,
            "unread": "UNREAD" in (m.get("labelIds") or []),
            "tags": tags,
            "snippet": snippet,
        })

    if args.json:
        print(json.dumps({"query": q, "count": len(rows), "messages": rows}, indent=2))
        return
    if not rows:
        print(f"No messages for query: {q!r}")
        return
    print(f"{len(rows)} message(s) for query: {q!r}\n")
    for r in rows:
        flag = "*" if r["unread"] else " "
        tagstr = f"  [{', '.join(r['tags'])}]" if r["tags"] else ""
        print(f"{flag} {r['id']}  {r['date']}")
        print(f"    From: {r['from']}")
        print(f"    Subj: {r['subject']}{tagstr}")
        print(f"    {r['snippet'][:200]}")
        print()


def _render_message(svc, msg_id, save_dir=None, as_json=False):
    m = _msg_meta(svc, msg_id, "full")
    payload = m.get("payload", {})
    headers = payload.get("headers", [])
    subject = _header(headers, "Subject")
    body = extract_body(payload)
    atts = list_attachments(payload)
    tags = classify(subject, body)
    links = find_links(body)

    saved = []
    if save_dir and atts:
        saved = _save_attachments(svc, msg_id, atts, Path(save_dir))

    info = {
        "id": msg_id,
        "threadId": m.get("threadId"),
        "from": _header(headers, "From"),
        "to": _header(headers, "To"),
        "cc": _header(headers, "Cc"),
        "date": _header(headers, "Date"),
        "subject": subject,
        "tags": tags,
        "labelIds": m.get("labelIds", []),
        "links": links,
        "attachments": [
            {"filename": a["filename"], "mimeType": a["mimeType"], "size": a["size"]}
            for a in atts
        ],
        "saved": [str(p) for p in saved],
        "body": body,
    }
    if as_json:
        print(json.dumps(info, indent=2))
        return info

    print(f"Id:      {info['id']}")
    print(f"Thread:  {info['threadId']}")
    print(f"From:    {info['from']}")
    print(f"To:      {info['to']}")
    if info["cc"]:
        print(f"Cc:      {info['cc']}")
    print(f"Date:    {info['date']}")
    print(f"Subject: {info['subject']}")
    if tags:
        print(f"Tags:    {', '.join(tags)}")
    if info["attachments"]:
        print("Attachments:")
        for a in info["attachments"]:
            print(f"    - {a['filename']} ({a['mimeType']}, {a['size']} bytes)")
    if saved:
        print("Saved:")
        for p in saved:
            print(f"    - {p}")
    if links:
        print("Links:")
        for u in links:
            print(f"    - {u}")
    print("\n--- body ---")
    print(body)
    return info


def cmd_read(args):
    svc = get_service(args, interactive_ok=False)
    _render_message(svc, args.id, save_dir=args.save_attachments, as_json=args.json)
    if args.mark_read:
        svc.users().messages().modify(
            userId="me", id=args.id, body={"removeLabelIds": ["UNREAD"]}
        ).execute()


def cmd_thread(args):
    svc = get_service(args, interactive_ok=False)
    t = svc.users().threads().get(userId="me", id=args.id, format="full").execute()
    msgs = t.get("messages", [])
    if args.json:
        out = []
        for m in msgs:
            payload = m.get("payload", {})
            headers = payload.get("headers", [])
            out.append({
                "id": m["id"],
                "from": _header(headers, "From"),
                "date": _header(headers, "Date"),
                "subject": _header(headers, "Subject"),
                "body": extract_body(payload),
            })
        print(json.dumps({"threadId": args.id, "messages": out}, indent=2))
        return
    print(f"Thread {args.id} — {len(msgs)} message(s)\n")
    for i, m in enumerate(msgs, 1):
        payload = m.get("payload", {})
        headers = payload.get("headers", [])
        print(f"===== [{i}/{len(msgs)}] {m['id']} =====")
        print(f"From: {_header(headers, 'From')}")
        print(f"Date: {_header(headers, 'Date')}")
        print(f"Subj: {_header(headers, 'Subject')}")
        print()
        print(extract_body(payload))
        print()


def _save_attachments(svc, msg_id, atts, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for a in atts:
        if a.get("data"):
            raw = _b64d(a["data"])
        elif a.get("attachmentId"):
            att = svc.users().messages().attachments().get(
                userId="me", messageId=msg_id, id=a["attachmentId"]
            ).execute()
            raw = _b64d(att["data"])
        else:
            continue
        name = a["filename"] or f"attachment-{a.get('attachmentId', 'x')[:8]}"
        out = dest / name
        n = 1
        while out.exists():
            out = dest / f"{Path(name).stem}({n}){Path(name).suffix}"
            n += 1
        out.write_bytes(raw)
        saved.append(out)
    return saved


def cmd_download(args):
    svc = get_service(args, interactive_ok=False)
    m = _msg_meta(svc, args.id, "full")
    atts = list_attachments(m.get("payload", {}))
    if not atts:
        print("No attachments on this message.")
        return
    saved = _save_attachments(svc, args.id, atts, Path(args.dir))
    for p in saved:
        print(f"Saved {p}")


def _build_mime(to, subject, body, cc=None, from_addr=None,
                in_reply_to=None, references=None, attachments=None):
    msg = EmailMessage()
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    if from_addr:
        msg["From"] = from_addr
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    msg.set_content(body)
    for path in attachments or []:
        p = Path(path)
        ctype, _ = mimetypes.guess_type(p.name)
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        msg.add_attachment(p.read_bytes(), maintype=maintype,
                           subtype=subtype, filename=p.name)
    return {"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()}


def _read_body(args) -> str:
    if getattr(args, "body_file", None):
        return Path(args.body_file).read_text(encoding="utf-8")
    return args.body or ""


def cmd_send(args):
    svc = get_service(args, interactive_ok=False)
    raw = _build_mime(
        to=args.to, subject=args.subject, body=_read_body(args),
        cc=args.cc, attachments=args.attach,
    )
    sent = svc.users().messages().send(userId="me", body=raw).execute()
    print(f"Sent. id={sent.get('id')} threadId={sent.get('threadId')}")


def _reply_fields(svc, msg_id, reply_all):
    m = _msg_meta(svc, msg_id, "metadata",
                  ["From", "To", "Cc", "Subject", "Message-ID", "References"])
    headers = m.get("payload", {}).get("headers", [])
    prof = svc.users().getProfile(userId="me").execute()
    me = (prof.get("emailAddress") or "").lower()

    orig_from = _header(headers, "From")
    orig_to = _header(headers, "To")
    orig_cc = _header(headers, "Cc")
    subject = _header(headers, "Subject")
    msgid = _header(headers, "Message-ID")
    refs = _header(headers, "References")

    if not subject.lower().startswith("re:"):
        subject = "Re: " + subject

    to = orig_from
    cc = ""
    if reply_all:
        extras = []
        for chunk in (orig_to, orig_cc):
            for addr in chunk.split(","):
                addr = addr.strip()
                if addr and me not in addr.lower() and addr.lower() not in orig_from.lower():
                    extras.append(addr)
        cc = ", ".join(dict.fromkeys(extras))

    references = (refs + " " + msgid).strip() if refs else msgid
    return {
        "to": to, "cc": cc, "subject": subject,
        "in_reply_to": msgid, "references": references,
        "threadId": m.get("threadId"),
    }


def cmd_reply(args):
    svc = get_service(args, interactive_ok=False)
    f = _reply_fields(svc, args.id, args.reply_all)
    raw = _build_mime(
        to=f["to"], subject=f["subject"], body=_read_body(args),
        cc=f["cc"] or None, in_reply_to=f["in_reply_to"],
        references=f["references"], attachments=args.attach,
    )
    raw["threadId"] = f["threadId"]
    sent = svc.users().messages().send(userId="me", body=raw).execute()
    print(f"Replied. id={sent.get('id')} threadId={sent.get('threadId')}")


def cmd_draft(args):
    """Create a draft (does NOT send). Preferred when a human should review."""
    svc = get_service(args, interactive_ok=False)
    threadId = None
    if args.reply_to:
        f = _reply_fields(svc, args.reply_to, args.reply_all)
        raw = _build_mime(
            to=args.to or f["to"], subject=args.subject or f["subject"],
            body=_read_body(args), cc=args.cc or (f["cc"] or None),
            in_reply_to=f["in_reply_to"], references=f["references"],
            attachments=args.attach,
        )
        threadId = f["threadId"]
    else:
        raw = _build_mime(
            to=args.to, subject=args.subject or "", body=_read_body(args),
            cc=args.cc, attachments=args.attach,
        )
    body = {"message": raw}
    if threadId:
        body["message"]["threadId"] = threadId
    d = svc.users().drafts().create(userId="me", body=body).execute()
    print(f"Draft created. draftId={d.get('id')} "
          f"(review/send it in Gmail, or run: send-draft --id {d.get('id')})")


def cmd_send_draft(args):
    svc = get_service(args, interactive_ok=False)
    sent = svc.users().drafts().send(userId="me", body={"id": args.id}).execute()
    print(f"Draft sent. id={sent.get('id')} threadId={sent.get('threadId')}")


def cmd_mark(args):
    svc = get_service(args, interactive_ok=False)
    body = {}
    if args.read:
        body["removeLabelIds"] = ["UNREAD"]
    if args.unread:
        body["addLabelIds"] = ["UNREAD"]
    svc.users().messages().modify(userId="me", id=args.id, body=body).execute()
    print(f"Updated {args.id}: {body}")


def _label_map(svc):
    labels = svc.users().labels().list(userId="me").execute().get("labels", [])
    return {l["name"].lower(): l["id"] for l in labels}, labels


def cmd_label(args):
    svc = get_service(args, interactive_ok=False)
    name_to_id, labels = _label_map(svc)

    def resolve(name, create=False):
        lid = name_to_id.get(name.lower())
        if lid:
            return lid
        if create:
            created = svc.users().labels().create(
                userId="me", body={"name": name}
            ).execute()
            name_to_id[name.lower()] = created["id"]
            return created["id"]
        # allow passing a raw system label id like STARRED / IMPORTANT
        return name

    body = {}
    if args.add:
        body["addLabelIds"] = [resolve(n, create=True) for n in args.add]
    if args.remove:
        body["removeLabelIds"] = [resolve(n) for n in args.remove]
    svc.users().messages().modify(userId="me", id=args.id, body=body).execute()
    print(f"Updated labels on {args.id}: {body}")


def cmd_labels(args):
    svc = get_service(args, interactive_ok=False)
    _, labels = _label_map(svc)
    for l in sorted(labels, key=lambda x: x["name"].lower()):
        print(f"{l['id']:20} {l['name']}")


# --------------------------------------------------------------------------- #
# Arg parsing
# --------------------------------------------------------------------------- #
def build_parser():
    p = argparse.ArgumentParser(description="Gmail helper for the job-search skill.")
    p.add_argument("--profile", help="named person subfolder under the base dir")
    p.add_argument("--data-dir", help="explicit data dir (overrides --profile)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("--json", action="store_true", help="machine-readable output")

    sp = sub.add_parser("auth", help="run OAuth flow / refresh token")
    sp.add_argument("--no-browser", action="store_true",
                    help="don't open the system browser; print the consent URL "
                         "(prefixed 'AUTH_URL:') so an agent can drive consent "
                         "in its own Chrome. Run this unbuffered and backgrounded, "
                         "e.g. python -u gmail_cli.py auth --no-browser > auth.log 2>&1 &")
    sp.set_defaults(func=cmd_auth)

    sp = sub.add_parser("whoami", help="show the authorized account")
    add_common(sp)
    sp.set_defaults(func=cmd_whoami)

    sp = sub.add_parser("search", help="search messages (Gmail query syntax)")
    sp.add_argument("--query", "-q", default="", help="Gmail search query")
    sp.add_argument("--max", type=int, default=15)
    sp.add_argument("--unread", action="store_true")
    sp.add_argument("--newer-than", help="e.g. 7d, 2w, 1m")
    sp.add_argument("--from", dest="from_addr", help="filter by sender")
    sp.add_argument("--label", help="filter by label")
    add_common(sp)
    sp.set_defaults(func=cmd_search)

    sp = sub.add_parser("read", help="read one message (headers + body + links)")
    sp.add_argument("--id", required=True)
    sp.add_argument("--save-attachments", metavar="DIR",
                    help="also save attachments to DIR")
    sp.add_argument("--mark-read", action="store_true")
    add_common(sp)
    sp.set_defaults(func=cmd_read)

    sp = sub.add_parser("thread", help="read a whole thread")
    sp.add_argument("--id", required=True)
    add_common(sp)
    sp.set_defaults(func=cmd_thread)

    sp = sub.add_parser("download", help="download a message's attachments")
    sp.add_argument("--id", required=True)
    sp.add_argument("--dir", default=".")
    sp.set_defaults(func=cmd_download)

    def add_compose_args(sp):
        sp.add_argument("--to")
        sp.add_argument("--cc")
        sp.add_argument("--subject")
        sp.add_argument("--body")
        sp.add_argument("--body-file", help="read body text from a file")
        sp.add_argument("--attach", nargs="*", default=[], help="file path(s) to attach")

    sp = sub.add_parser("send", help="send a new email (sends immediately)")
    add_compose_args(sp)
    sp.set_defaults(func=cmd_send)

    sp = sub.add_parser("reply", help="reply in a thread (sends immediately)")
    sp.add_argument("--id", required=True, help="message id to reply to")
    sp.add_argument("--reply-all", action="store_true")
    sp.add_argument("--body")
    sp.add_argument("--body-file")
    sp.add_argument("--attach", nargs="*", default=[])
    sp.set_defaults(func=cmd_reply)

    sp = sub.add_parser("draft", help="create a draft (does NOT send)")
    sp.add_argument("--reply-to", help="message id this draft replies to")
    sp.add_argument("--reply-all", action="store_true")
    add_compose_args(sp)
    sp.set_defaults(func=cmd_draft)

    sp = sub.add_parser("send-draft", help="send a previously created draft")
    sp.add_argument("--id", required=True, help="draftId")
    sp.set_defaults(func=cmd_send_draft)

    sp = sub.add_parser("mark", help="mark a message read/unread")
    sp.add_argument("--id", required=True)
    sp.add_argument("--read", action="store_true")
    sp.add_argument("--unread", action="store_true")
    sp.set_defaults(func=cmd_mark)

    sp = sub.add_parser("label", help="add/remove labels on a message")
    sp.add_argument("--id", required=True)
    sp.add_argument("--add", nargs="*", default=[], help="label name(s) to add (created if new)")
    sp.add_argument("--remove", nargs="*", default=[], help="label name(s) to remove")
    sp.set_defaults(func=cmd_label)

    sp = sub.add_parser("labels", help="list all labels")
    sp.set_defaults(func=cmd_labels)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as e:  # surface API errors cleanly for the agent
        try:
            from googleapiclient.errors import HttpError
            if isinstance(e, HttpError):
                sys.exit(f"Gmail API error: {e}")
        except ImportError:
            pass
        sys.exit(f"Error: {e}")


if __name__ == "__main__":
    main()
