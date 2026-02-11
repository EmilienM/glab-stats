#!/usr/bin/env python3
# pylint: disable=too-many-lines
"""Fetch merge request / pull request data from GitLab and GitHub repositories."""

import argparse
import contextlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import requests
import yaml
from requests.adapters import HTTPAdapter
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential
from tqdm import tqdm

GITLAB_API_BASE = "https://gitlab.com/api/v4"
GITHUB_API_BASE = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
JIRA_BASE_URL = "https://issues.redhat.com"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "frontend", "data", "data.json")
DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "repos.yaml")

JIRA_KEY_RE = re.compile(r"([A-Z][A-Z0-9]+-\d+)")

# AI co-author detection patterns (from ai-co-author-scanner)
AI_PATTERNS = [
    r"ai\s+assistant",
    r"ai\s+code",
    r"amazon\s+codewhisperer",
    r"anthropic",
    r"artificial\s+intelligence",
    r"assistant",
    r"bard",
    r"chatgpt",
    r"claude",
    r"codeium",
    r"codewhisperer",
    r"copilot",
    r"cursor",
    r"gemini",
    r"github\s+copilot",
    r"gpt-",
    r"jetbrains\s+ai",
    r"large\s+language\s+model",
    r"llm",
    r"machine\s+learning",
    r"openai",
    r"replit",
    r"sourcegraph\s+cody",
    r"tabnine",
    r"v0",
    r"vercel",
    r"windsurf",
]
AI_REGEX = re.compile("|".join(f"({p})" for p in AI_PATTERNS), re.IGNORECASE)

CO_AUTHOR_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"Co-Authored-By:\s*(.+)",
        r"Generated-By:\s*(.+)",
        r"Assisted-By:\s*(.+)",
        r"AI-Agent:\s*(.+)",
        r"Generated\s+with:\s*(.+)",
        r"Created\s+with:\s*(.+)",
        r"Built\s+with:\s*(.+)",
        r"Powered\s+by:\s*(.+)",
    ]
]

CO_AUTHOR_RE = re.compile(r"Co-Authored-By:\s*(.+)", re.IGNORECASE)
CO_AUTHOR_NAME_EMAIL_RE = re.compile(r"^(.+?)\s*<([^>]+)>$")


class RateLimitThrottle:
    """Thread-safe proactive rate-limit throttle.

    Reads rate-limit headers from every response and blocks all threads when
    remaining quota drops below a safety threshold, waiting until the reset
    window passes instead of hitting 403s.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._limit: int | None = None
        self._remaining: int | None = None
        self._reset_ts: float | None = None

    def update_from_response(self, resp: requests.Response) -> None:
        """Extract rate-limit headers from *resp* and update internal state."""
        headers = resp.headers
        # GitHub: X-RateLimit-*   GitLab: RateLimit-*
        raw_limit = headers.get("X-RateLimit-Limit") or headers.get("RateLimit-Limit")
        raw_remaining = headers.get("X-RateLimit-Remaining") or headers.get("RateLimit-Remaining")
        raw_reset = headers.get("X-RateLimit-Reset") or headers.get("RateLimit-Reset")

        if raw_remaining is None:
            return

        with self._lock:
            try:
                self._remaining = int(raw_remaining)
            except ValueError:
                return
            if raw_limit is not None:
                with contextlib.suppress(ValueError):
                    self._limit = int(raw_limit)
            if raw_reset is not None:
                with contextlib.suppress(ValueError):
                    self._reset_ts = float(raw_reset)

    def wait_if_needed(self) -> None:
        """Block the calling thread if the remaining quota is below the safety threshold."""
        with self._lock:
            if self._remaining is None or self._reset_ts is None:
                return

            # Threshold: 10% of limit or 50, whichever is higher
            threshold = max(int(self._limit * 0.10) if self._limit else 50, 50)

            if self._remaining > threshold:
                return

            wait_secs = self._reset_ts - time.time()
            if wait_secs <= 0:
                return

            reset_ts = self._reset_ts

        # Sleep outside the lock so other threads can still update state
        print(
            f"  Rate limit low ({self._remaining} remaining), "
            f"waiting {wait_secs:.0f}s for reset...",
            file=sys.stderr,
        )
        # Re-check periodically in case another thread already waited
        while time.time() < reset_ts:
            time.sleep(min(reset_ts - time.time(), 1.0))


@dataclass
class ForgeContext:
    """Per-forge context bundling shared resources for API calls."""

    throttle: RateLimitThrottle = field(default_factory=RateLimitThrottle)


def detect_ai_coauthor(description):
    """Detect AI co-authorship from an MR description.

    Scans for co-author trailers (Co-Authored-By, Generated-By, Assisted-By, etc.)
    and checks if any match known AI tool patterns.
    """
    if not description:
        return False
    for line in description.split("\n"):
        line = line.strip()
        for pattern in CO_AUTHOR_PATTERNS:
            match = pattern.search(line)
            if match:
                value = match.group(1).strip()
                # Remove Signed-off-by trailer if appended on the same line
                if "signed-off-by" in value.lower():
                    value = re.split(r"\s+signed-off-by\s*:", value, flags=re.IGNORECASE)[0].strip()
                if AI_REGEX.search(value):
                    return True
    return False


def extract_human_coauthors(description):
    """Extract human co-authors from Co-Authored-By lines in an MR description.

    Parses only Co-Authored-By trailers, skips entries that match AI patterns,
    and returns a list of {"name": ..., "email": ...} dicts for human co-authors.
    """
    if not description:
        return []
    coauthors = []
    for line in description.split("\n"):
        line = line.strip()
        match = CO_AUTHOR_RE.search(line)
        if not match:
            continue
        value = match.group(1).strip()
        # Remove Signed-off-by trailer if appended on the same line
        if "signed-off-by" in value.lower():
            value = re.split(r"\s+signed-off-by\s*:", value, flags=re.IGNORECASE)[0].strip()
        # Skip AI co-authors
        if AI_REGEX.search(value):
            continue
        # Extract name and email from "Name <email>" format
        name_email = CO_AUTHOR_NAME_EMAIL_RE.match(value)
        if name_email:
            coauthors.append(
                {
                    "name": name_email.group(1).strip(),
                    "email": name_email.group(2).strip(),
                }
            )
        else:
            coauthors.append({"name": value, "email": ""})
    return coauthors


def is_bot_account(username, bot_accounts):
    """Check if a username is in the bot accounts list."""
    return username in bot_accounts


def _is_retryable_error(exc):
    return (
        isinstance(exc, requests.HTTPError)
        and exc.response is not None
        and (exc.response.status_code == 403 or exc.response.status_code >= 500)
    )


def _rate_limit_wait(retry_state):
    """Wait strategy that respects rate-limit headers on 403, exponential backoff otherwise."""
    exc = retry_state.outcome.exception()
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        resp = exc.response
        if resp.status_code == 403:
            # Secondary rate limit: Retry-After header
            retry_after = resp.headers.get("Retry-After")
            if retry_after:
                try:
                    return max(int(retry_after), 1)
                except ValueError:
                    pass
            # Primary rate limit: X-RateLimit-Reset header
            remaining = resp.headers.get("X-RateLimit-Remaining")
            reset_ts = resp.headers.get("X-RateLimit-Reset")
            if remaining == "0" and reset_ts:
                try:
                    wait_secs = int(reset_ts) - int(datetime.now(UTC).timestamp())
                    return max(wait_secs, 1)
                except ValueError:
                    pass
    # Fallback: exponential backoff for 5xx or 403 without rate-limit headers
    return wait_exponential(multiplier=2, min=2, max=30)(retry_state)


def _log_retry(retry_state):
    """Log retries so the user knows what is happening."""
    exc = retry_state.outcome.exception()
    wait = retry_state.upcoming_sleep
    attempt = retry_state.attempt_number
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        resp = exc.response
        status = resp.status_code
        url = resp.url or resp.request.url if resp.request else "unknown"
        print(
            f"  HTTP {status} on {url} (attempt {attempt}/5), retrying in {wait:.0f}s...",
            file=sys.stderr,
        )


@retry(
    retry=retry_if_exception(_is_retryable_error),
    stop=stop_after_attempt(5),
    wait=_rate_limit_wait,
    before_sleep=_log_retry,
    reraise=True,
)
def _checked_get(session, url, ctx: ForgeContext | None = None, **kwargs):
    """GET with raise_for_status and automatic retry on 5xx and 403 errors."""
    if ctx:
        ctx.throttle.wait_if_needed()
    resp = session.get(url, **kwargs)
    if ctx:
        ctx.throttle.update_from_response(resp)
    resp.raise_for_status()
    return resp


def _simple_get(session, url, ctx: ForgeContext | None = None, **kwargs):
    """GET with raise_for_status but *no* automatic retries.

    Used for paginated listing endpoints where the caller handles errors
    itself (e.g. by shifting a date-window cursor instead of retrying the
    same failing page).
    """
    if ctx:
        ctx.throttle.wait_if_needed()
    resp = session.get(url, **kwargs)
    if ctx:
        ctx.throttle.update_from_response(resp)
    resp.raise_for_status()
    return resp


def _github_paginated_get(session, url, per_page=100, params=None, ctx: ForgeContext | None = None):
    """Yield pages of JSON from a paginated GitHub API endpoint."""
    req_params = dict(params or {})
    req_params["per_page"] = per_page
    req_params["page"] = 1
    while True:
        resp = _checked_get(session, url, ctx=ctx, params=req_params)
        data = resp.json()
        if not data:
            break
        yield data
        if len(data) < per_page:
            break
        req_params["page"] += 1


def load_config(config_path=None):
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH
    with open(config_path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    raw = config.get("repositories", {})

    # Team-based dict format: { team_name: [repo_entries...], ... }
    repo_by_url: dict[str, dict] = {}
    for team_name, entries in raw.items():
        for entry in entries or []:
            url = entry if isinstance(entry, str) else entry["url"]

            if url in repo_by_url:
                existing = repo_by_url[url]
                if team_name not in existing["teams"]:
                    existing["teams"].append(team_name)
            else:
                repo_by_url[url] = {
                    "url": url,
                    "teams": [team_name],
                }

    repos = list(repo_by_url.values())
    # All team names, sorted for deterministic output
    teams = sorted(raw.keys())
    bot_accounts = set(config.get("bot_accounts", []))
    return repos, bot_accounts, teams


def detect_forge(url):
    """Return 'github' or 'gitlab' based on the URL prefix."""
    if url.startswith("https://github.com/"):
        return "github"
    if url.startswith("https://gitlab.com/"):
        return "gitlab"
    raise ValueError(f"Unsupported forge URL: {url}")


def extract_project_path(url):
    """Extract project path from a GitLab URL.

    e.g. https://gitlab.com/foo/bar -> foo/bar
    """
    url = url.rstrip("/")
    prefix = "https://gitlab.com/"
    if url.startswith(prefix):
        return url[len(prefix) :]
    raise ValueError(f"Unsupported GitLab URL: {url}")


def extract_github_repo_path(url):
    """Extract owner/repo from a GitHub URL.

    e.g. https://github.com/owner/repo -> owner/repo
    """
    url = url.rstrip("/")
    prefix = "https://github.com/"
    if url.startswith(prefix):
        return url[len(prefix) :]
    raise ValueError(f"Unsupported GitHub URL: {url}")


def _compute_window_delta(all_mrs, target_mrs=400):
    """Estimate a timedelta that should contain roughly *target_mrs* merge requests.

    Uses the density of MRs already collected to extrapolate.  Returns a
    ``timedelta`` or ``None`` if not enough data to estimate.
    """
    if len(all_mrs) < 2:
        return None
    newest = datetime.fromisoformat(all_mrs[0]["created_at"])
    oldest = datetime.fromisoformat(all_mrs[-1]["created_at"])
    span = (newest - oldest).total_seconds()
    if span <= 0:
        return None
    rate = len(all_mrs) / span  # MRs per second
    secs = target_mrs / rate
    # Add 20 % margin and clamp to at least 1 hour
    return timedelta(seconds=max(secs * 1.2, 3600))


def fetch_merge_requests(
    session,
    project_path,
    limit,
    bot_accounts,
    ctx: ForgeContext | None = None,
    *,
    verbose: bool = False,
):
    """Fetch merge requests for a project, up to `limit`, handling pagination.

    Uses date-window pagination to avoid deep offsets: results are ordered by
    ``created_at desc``.  The first pass runs without date filters; on a 500
    error (GitLab's offset-pagination limit on large projects) or when there
    are no more pages, a narrow ``created_after`` / ``created_before`` window
    is computed from the MR density seen so far and fetching continues from
    page 1 inside that window.  This keeps page numbers low and avoids the
    query timeouts that GitLab returns for deep offsets.
    """
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests"
    per_page = min(limit, 100)
    params: dict[str, str | int] = {
        "state": "all",
        "per_page": per_page,
        "page": 1,
        "order_by": "created_at",
        "sort": "desc",
    }
    all_mrs: list[dict] = []
    seen_iids: set[int] = set()
    empty_window_count = 0
    max_empty_windows = 5

    def _dbg(msg: str) -> None:
        if verbose:
            print(f"  [DEBUG] {msg}", file=sys.stderr)

    def _shift_window() -> bool:
        """Move the created_before/created_after window back.

        Returns True if a new window was set, False if we cannot continue.
        """
        nonlocal empty_window_count
        if not all_mrs:
            return False
        if empty_window_count >= max_empty_windows:
            _dbg(f"Reached {max_empty_windows} consecutive empty windows, stopping.")
            return False
        delta = _compute_window_delta(all_mrs)
        if delta is None:
            return False
        # If a window is already active, slide it back by using the current
        # created_after as the new created_before instead of re-anchoring on
        # the same oldest MR (which would produce the same window forever).
        if "created_before" in params and "created_after" in params:
            before_dt = datetime.fromisoformat(str(params["created_after"]))
        else:
            before_dt = datetime.fromisoformat(all_mrs[-1]["created_at"])
        after_dt = before_dt - delta
        params["created_before"] = before_dt.isoformat()
        params["created_after"] = after_dt.isoformat()
        params["page"] = 1
        _dbg(
            f"Shifting window: created_before={params['created_before']}, "
            f"created_after={params['created_after']}, delta={delta}"
        )
        return True

    while len(all_mrs) < limit:
        _dbg(f"Requesting: {url} params={params}")
        try:
            resp = _simple_get(session, url, ctx=ctx, params=params)
        except requests.HTTPError as exc:
            resp_obj = exc.response
            _dbg(
                f"Request failed: status={getattr(resp_obj, 'status_code', '?')}, "
                f"url={getattr(resp_obj, 'url', '?')}, "
                f"headers={dict(resp_obj.headers) if resp_obj is not None else '?'}, "
                f"body={resp_obj.text[:500] if resp_obj is not None else '?'}"
            )
            if _shift_window():
                print(
                    f"  Page {params.get('page')} failed ({exc}), shifting date window...",
                    file=sys.stderr,
                )
                continue
            print(
                f"  Warning: listing failed ({exc}), "
                f"returning {len(all_mrs)} MRs collected so far.",
                file=sys.stderr,
            )
            break

        _dbg(
            f"Response: status={resp.status_code}, "
            f"x-page={resp.headers.get('x-page')}, "
            f"x-next-page={resp.headers.get('x-next-page')}, "
            f"x-total={resp.headers.get('x-total')}, "
            f"x-total-pages={resp.headers.get('x-total-pages')}"
        )
        data = resp.json()
        if not data:
            _dbg("Empty response body in current window.")
            empty_window_count += 1
            # Window exhausted — slide to the next one
            if _shift_window():
                continue
            break

        _dbg(f"Got {len(data)} items in this page.")

        empty_window_count = 0
        new_in_page = False
        for mr in data:
            if len(all_mrs) >= limit:
                break

            # Guard against duplicates when shifting the date window
            if mr["iid"] in seen_iids:
                continue

            author = mr.get("author") or {}
            author_username = author.get("username", "unknown")

            # Skip merge requests from bot accounts
            if is_bot_account(author_username, bot_accounts):
                seen_iids.add(mr["iid"])
                continue

            mr_description = mr.get("description") or ""
            seen_iids.add(mr["iid"])
            new_in_page = True
            all_mrs.append(
                {
                    "iid": mr["iid"],
                    "title": mr["title"],
                    "state": mr["state"],
                    "created_at": mr["created_at"],
                    "merged_at": mr.get("merged_at"),
                    "updated_at": mr["updated_at"],
                    "web_url": mr["web_url"],
                    "ai_coauthored": detect_ai_coauthor(mr_description),
                    "co_authors": extract_human_coauthors(mr_description),
                    "author": {
                        "username": author_username,
                        "name": author.get("name", "Unknown"),
                        "avatar_url": author.get("avatar_url", ""),
                    },
                }
            )

        _dbg(f"Total collected: {len(all_mrs)}/{limit}, seen_iids: {len(seen_iids)}")

        if not new_in_page:
            _dbg("No new MRs in this page (all duplicates/bots).")
            if _shift_window():
                continue
            break

        next_page = resp.headers.get("x-next-page")
        if next_page:
            _dbg(f"Next page from header: {next_page}")
            params["page"] = int(next_page)
        elif _shift_window():
            continue
        else:
            break

    _dbg(f"Done. Returning {len(all_mrs)} MRs.")
    return all_mrs


def count_diff_lines(diff_text):
    """Count additions and deletions from a unified diff string."""
    additions = 0
    deletions = 0
    for line in diff_text.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            additions += 1
        elif line.startswith("-") and not line.startswith("---"):
            deletions += 1
    return additions, deletions


def fetch_mr_diff_stats(session, project_path, mr_iid, ctx: ForgeContext | None = None):
    """Fetch diff stats (additions/deletions) for a single merge request."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/changes"
    resp = _checked_get(session, url, ctx=ctx)
    data = resp.json()

    total_additions = 0
    total_deletions = 0
    for change in data.get("changes", []):
        diff = change.get("diff", "")
        adds, dels = count_diff_lines(diff)
        total_additions += adds
        total_deletions += dels

    return total_additions, total_deletions


def fetch_mr_comments(session, project_path, mr_iid, bot_accounts, ctx: ForgeContext | None = None):
    """Fetch user comments for a merge request, return individual entries with timestamps."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/notes"
    params = {"per_page": 100, "page": 1}
    comments: list[dict[str, str]] = []

    while True:
        resp = _checked_get(session, url, ctx=ctx, params=params)
        notes = resp.json()
        if not notes:
            break

        for note in notes:
            if note.get("system"):
                continue
            author = note.get("author") or {}
            username = author.get("username", "unknown")

            # Skip comments from bot accounts
            if is_bot_account(username, bot_accounts):
                continue

            comments.append(
                {
                    "username": username,
                    "name": author.get("name", "Unknown"),
                    "avatar_url": author.get("avatar_url", ""),
                    "created_at": note.get("created_at", ""),
                }
            )

        next_page = resp.headers.get("x-next-page")
        if not next_page:
            break
        params["page"] = int(next_page)

    return comments


def fetch_mr_approvals(
    session, project_path, mr_iid, bot_accounts, ctx: ForgeContext | None = None
):
    """Fetch approvals for a merge request, return list of approvers."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/approvals"
    resp = _checked_get(session, url, ctx=ctx)
    data = resp.json()

    approvers = []
    for entry in data.get("approved_by", []):
        user = entry.get("user") or {}
        username = user.get("username", "unknown")

        # Skip approvals from bot accounts
        if is_bot_account(username, bot_accounts):
            continue

        approvers.append(
            {
                "username": username,
                "name": user.get("name", "Unknown"),
                "avatar_url": user.get("avatar_url", ""),
                "approved_at": entry.get("approved_at", ""),
            }
        )

    return approvers


def extract_jira_key(title):
    """Extract Jira ticket key from an MR title (e.g. 'RHEL-1234: fix foo')."""
    m = JIRA_KEY_RE.search(title)
    return m.group(1) if m else None


def fetch_jira_priority(jira_session, jira_key):
    """Fetch the priority of a Jira ticket. Returns the priority name or None."""
    url = f"{JIRA_BASE_URL}/rest/api/2/issue/{jira_key}"
    try:
        resp = jira_session.get(url, params={"fields": "priority"})
        resp.raise_for_status()
        data = resp.json()
        priority = data.get("fields", {}).get("priority")
        if priority:
            return priority.get("name")
    except requests.RequestException:
        pass
    return None


def _fetch_mr_details(
    session, jira_session, project_path, mr, bot_accounts, *, ctx: ForgeContext | None = None
):
    """Fetch diff stats, comments, approvals, and Jira priority for a single MR."""
    additions, deletions = fetch_mr_diff_stats(session, project_path, mr["iid"], ctx=ctx)
    mr["additions"] = additions
    mr["deletions"] = deletions
    mr["commenters"] = fetch_mr_comments(session, project_path, mr["iid"], bot_accounts, ctx=ctx)
    mr["approvers"] = fetch_mr_approvals(session, project_path, mr["iid"], bot_accounts, ctx=ctx)

    jira_key = extract_jira_key(mr["title"])
    mr["jira_key"] = jira_key
    if jira_key and jira_session:
        mr["jira_priority"] = fetch_jira_priority(jira_session, jira_key)
    else:
        mr["jira_priority"] = None

    return mr


def fetch_github_pull_requests(
    session, repo_path, limit, bot_accounts, ctx: ForgeContext | None = None
):
    """Fetch pull requests for a GitHub repo, up to `limit`, handling pagination."""
    url = f"{GITHUB_API_BASE}/repos/{repo_path}/pulls"
    params = {"state": "all", "sort": "created", "direction": "desc"}
    all_prs: list[dict] = []

    for page in _github_paginated_get(
        session, url, per_page=min(limit, 100), params=params, ctx=ctx
    ):
        for pr in page:
            if len(all_prs) >= limit:
                break
            author_login = (pr.get("user") or {}).get("login", "unknown")

            if is_bot_account(author_login, bot_accounts):
                continue

            pr_body = pr.get("body") or ""

            # Map GitHub state to the gitlab-compatible format
            if pr.get("merged_at"):
                state = "merged"
            elif pr["state"] == "closed":
                state = "closed"
            else:
                state = "opened"

            all_prs.append(
                {
                    "iid": pr["number"],
                    "title": pr["title"],
                    "state": state,
                    "created_at": pr["created_at"],
                    "merged_at": pr.get("merged_at"),
                    "updated_at": pr["updated_at"],
                    "web_url": pr["html_url"],
                    "ai_coauthored": detect_ai_coauthor(pr_body),
                    "co_authors": extract_human_coauthors(pr_body),
                    "author": {
                        "username": author_login,
                        "name": author_login,
                        "avatar_url": (pr.get("user") or {}).get("avatar_url", ""),
                    },
                }
            )
        if len(all_prs) >= limit:
            break

    return all_prs


def fetch_github_pr_diff_stats(session, repo_path, pr_number, ctx: ForgeContext | None = None):
    """Fetch diff stats (additions/deletions) for a single GitHub pull request."""
    url = f"{GITHUB_API_BASE}/repos/{repo_path}/pulls/{pr_number}"
    resp = _checked_get(session, url, ctx=ctx)
    data = resp.json()
    return data.get("additions", 0), data.get("deletions", 0)


def fetch_github_pr_comments(
    session, repo_path, pr_number, bot_accounts, ctx: ForgeContext | None = None
):
    """Fetch comments for a GitHub pull request (issue + review comments)."""
    comments: list[dict[str, str]] = []

    # Issue comments
    issue_url = f"{GITHUB_API_BASE}/repos/{repo_path}/issues/{pr_number}/comments"
    for page in _github_paginated_get(session, issue_url, ctx=ctx):
        for comment in page:
            username = (comment.get("user") or {}).get("login", "unknown")
            if is_bot_account(username, bot_accounts):
                continue
            comments.append(
                {
                    "username": username,
                    "name": username,
                    "avatar_url": (comment.get("user") or {}).get("avatar_url", ""),
                    "created_at": comment.get("created_at", ""),
                }
            )

    # Pull request review comments (inline)
    review_url = f"{GITHUB_API_BASE}/repos/{repo_path}/pulls/{pr_number}/comments"
    for page in _github_paginated_get(session, review_url, ctx=ctx):
        for comment in page:
            username = (comment.get("user") or {}).get("login", "unknown")
            if is_bot_account(username, bot_accounts):
                continue
            comments.append(
                {
                    "username": username,
                    "name": username,
                    "avatar_url": (comment.get("user") or {}).get("avatar_url", ""),
                    "created_at": comment.get("created_at", ""),
                }
            )

    return comments


def fetch_github_pr_approvals(
    session, repo_path, pr_number, bot_accounts, ctx: ForgeContext | None = None
):
    """Fetch approvals for a GitHub pull request from reviews."""
    url = f"{GITHUB_API_BASE}/repos/{repo_path}/pulls/{pr_number}/reviews"
    approvers = []

    for page in _github_paginated_get(session, url, ctx=ctx):
        for review in page:
            if review.get("state") != "APPROVED":
                continue
            username = (review.get("user") or {}).get("login", "unknown")
            if is_bot_account(username, bot_accounts):
                continue
            approvers.append(
                {
                    "username": username,
                    "name": username,
                    "avatar_url": (review.get("user") or {}).get("avatar_url", ""),
                    "approved_at": review.get("submitted_at", ""),
                }
            )

    return approvers


def _fetch_github_pr_details(
    session, jira_session, repo_path, pr, bot_accounts, *, ctx: ForgeContext | None = None
):
    """Fetch diff stats, comments, approvals, and Jira priority for a single PR."""
    additions, deletions = fetch_github_pr_diff_stats(session, repo_path, pr["iid"], ctx=ctx)
    pr["additions"] = additions
    pr["deletions"] = deletions
    pr["commenters"] = fetch_github_pr_comments(
        session, repo_path, pr["iid"], bot_accounts, ctx=ctx
    )
    pr["approvers"] = fetch_github_pr_approvals(
        session, repo_path, pr["iid"], bot_accounts, ctx=ctx
    )

    jira_key = extract_jira_key(pr["title"])
    pr["jira_key"] = jira_key
    if jira_key and jira_session:
        pr["jira_priority"] = fetch_jira_priority(jira_session, jira_key)
    else:
        pr["jira_priority"] = None

    return pr


def main():
    parser = argparse.ArgumentParser(
        description="Fetch merge request / pull request data from GitLab and GitHub."
    )
    parser.add_argument(
        "-n",
        "--limit",
        type=int,
        default=20,
        help="Number of most recent MRs/PRs to fetch per repo (default: 20)",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=4,
        help="Number of concurrent threads for fetching details (default: 4)",
    )
    parser.add_argument(
        "-r",
        "--repos",
        type=str,
        default=None,
        help=f"Path to repos configuration file (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose debug logging for pagination and API calls",
    )
    args = parser.parse_args()

    repos, bot_accounts, teams = load_config(args.repos)
    if not repos:
        config_file = args.repos or DEFAULT_CONFIG_PATH
        print(f"Error: No repositories found in {config_file}.", file=sys.stderr)
        sys.exit(1)

    # Determine which forges are needed
    forges_needed: set[str] = set()
    for repo_cfg in repos:
        forges_needed.add(detect_forge(repo_cfg["url"]))

    # Create sessions per forge, only requiring tokens for forges in use
    pool_size = max(args.workers, 10)
    adapter = HTTPAdapter(pool_maxsize=pool_size, pool_block=True)

    gitlab_session = None
    gitlab_ctx: ForgeContext | None = None
    if "gitlab" in forges_needed:
        gitlab_token = os.environ.get("GITLAB_TOKEN")
        if not gitlab_token:
            print("Error: GITLAB_TOKEN environment variable is not set.", file=sys.stderr)
            sys.exit(1)
        gitlab_session = requests.Session()
        gitlab_session.mount("https://", adapter)
        gitlab_session.headers["PRIVATE-TOKEN"] = gitlab_token
        gitlab_ctx = ForgeContext()

    github_session = None
    github_ctx: ForgeContext | None = None
    if "github" in forges_needed:
        github_token = os.environ.get("GITHUB_TOKEN")
        if not github_token:
            print("Error: GITHUB_TOKEN environment variable is not set.", file=sys.stderr)
            sys.exit(1)
        github_session = requests.Session()
        github_session.mount("https://", adapter)
        github_session.headers["Authorization"] = f"Bearer {github_token}"
        github_session.headers["Accept"] = "application/vnd.github+json"
        github_session.headers["X-GitHub-Api-Version"] = GITHUB_API_VERSION
        github_ctx = ForgeContext()

    if bot_accounts:
        bot_list = ", ".join(sorted(bot_accounts))
        print(f"Configured to ignore {len(bot_accounts)} bot accounts: {bot_list}")

    jira_token = os.environ.get("JIRA_API_TOKEN")
    jira_session = None
    if jira_token:
        jira_session = requests.Session()
        jira_session.headers["Authorization"] = f"Bearer {jira_token}"
    else:
        print("Warning: JIRA_API_TOKEN not set, skipping Jira priority lookup.", file=sys.stderr)

    result = {
        "generated_at": datetime.now(UTC).isoformat(),
        "teams": teams,
        "repositories": [],
    }

    def _write_result():
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

    try:
        for repo_cfg in repos:
            repo_url = repo_cfg["url"]
            forge = detect_forge(repo_url)

            if forge == "github":
                repo_path = extract_github_repo_path(repo_url)
                # github_session is guaranteed non-None: we sys.exit(1) above if token is missing
                session = github_session  # type: ignore[assignment]
                ctx = github_ctx
                print(f"Fetching up to {args.limit} PRs for {repo_path}...")
                mrs = fetch_github_pull_requests(
                    session, repo_path, args.limit, bot_accounts, ctx=ctx
                )
                print(f"  Found {len(mrs)} pull requests.")
                detail_fn = _fetch_github_pr_details
                unit = "PR"
            else:
                repo_path = extract_project_path(repo_url)
                # gitlab_session is guaranteed non-None: we sys.exit(1) above if token is missing
                session = gitlab_session  # type: ignore[assignment]
                ctx = gitlab_ctx
                print(f"Fetching up to {args.limit} MRs for {repo_path}...")
                mrs = fetch_merge_requests(
                    session,
                    repo_path,
                    args.limit,
                    bot_accounts,
                    ctx=ctx,
                    verbose=args.verbose,
                )
                print(f"  Found {len(mrs)} merge requests.")
                detail_fn = _fetch_mr_details
                unit = "MR"

            future_to_idx = {}
            errors = 0
            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                for i, mr in enumerate(mrs):
                    future = executor.submit(
                        detail_fn, session, jira_session, repo_path, mr, bot_accounts, ctx=ctx
                    )
                    future_to_idx[future] = i

                bar_fmt = (
                    "  {desc}: {percentage:3.0f}%|{bar}| "
                    "{n_fmt}/{total_fmt} [{elapsed}<{remaining}]"
                )
                with tqdm(
                    total=len(mrs),
                    desc=f"  {repo_path}",
                    unit=unit,
                    bar_format=bar_fmt,
                ) as pbar:
                    for future in as_completed(future_to_idx):
                        idx = future_to_idx[future]
                        try:
                            future.result()
                        except Exception as exc:  # noqa: BLE001  # pylint: disable=broad-exception-caught
                            errors += 1
                            mr = mrs[idx]
                            mr.setdefault("additions", 0)
                            mr.setdefault("deletions", 0)
                            mr.setdefault("commenters", [])
                            mr.setdefault("approvers", [])
                            mr.setdefault("jira_key", None)
                            mr.setdefault("jira_priority", None)
                            tqdm.write(
                                f"  Warning: failed to fetch details for "
                                f"{unit} !{mr['iid']}: {exc}",
                            )
                        pbar.update(1)
            if errors:
                print(
                    f"  {errors}/{len(mrs)} {unit}(s) had partial data due to API errors.",
                    file=sys.stderr,
                )

            result["repositories"].append(
                {
                    "name": repo_path.split("/")[-1],
                    "full_path": repo_path,
                    "web_url": repo_url,
                    "teams": repo_cfg.get("teams", []),
                    "merge_requests": mrs,
                }
            )

            # Write after each repo so partial data is preserved on later failures
            _write_result()
    except KeyboardInterrupt:
        print("\nInterrupted, saving partial data...", file=sys.stderr)
        _write_result()
        print(f"Partial data written to {OUTPUT_PATH}")
        sys.exit(130)

    print(f"\nData written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
