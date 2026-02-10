#!/usr/bin/env python3
"""Fetch merge request data from GitLab repositories and generate a JSON file."""

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from urllib.parse import quote

import requests
import yaml
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential
from tqdm import tqdm

GITLAB_API_BASE = "https://gitlab.com/api/v4"
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


def _is_server_error(exc):
    return (
        isinstance(exc, requests.HTTPError)
        and exc.response is not None
        and exc.response.status_code >= 500
    )


@retry(
    retry=retry_if_exception(_is_server_error),
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=2, min=2, max=30),
    reraise=True,
)
def _checked_get(session, url, **kwargs):
    """GET with raise_for_status and automatic retry on 5xx errors."""
    resp = session.get(url, **kwargs)
    resp.raise_for_status()
    return resp


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
            if isinstance(entry, str):
                url = entry
                skip = []
            else:
                url = entry["url"]
                skip = entry.get("skip_scoring", [])

            if url in repo_by_url:
                # Merge: union skip_scoring, append team
                existing = repo_by_url[url]
                existing["skip_scoring"] = list(set(existing["skip_scoring"]) | set(skip))
                if team_name not in existing["teams"]:
                    existing["teams"].append(team_name)
            else:
                repo_by_url[url] = {
                    "url": url,
                    "skip_scoring": skip,
                    "teams": [team_name],
                }

    repos = list(repo_by_url.values())
    # All team names, sorted for deterministic output
    teams = sorted(raw.keys())
    bot_accounts = set(config.get("bot_accounts", []))
    return repos, bot_accounts, teams


def extract_project_path(url):
    """Extract project path from a GitLab URL.

    e.g. https://gitlab.com/foo/bar -> foo/bar
    """
    url = url.rstrip("/")
    prefix = "https://gitlab.com/"
    if url.startswith(prefix):
        return url[len(prefix) :]
    raise ValueError(f"Unsupported GitLab URL: {url}")


def fetch_merge_requests(session, project_path, limit, bot_accounts):
    """Fetch merge requests for a project, up to `limit`, handling pagination."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests"
    per_page = min(limit, 100)
    params = {
        "state": "all",
        "per_page": per_page,
        "page": 1,
        "order_by": "created_at",
        "sort": "desc",
    }
    all_mrs = []

    while len(all_mrs) < limit:
        resp = _checked_get(session, url, params=params)
        data = resp.json()
        if not data:
            break

        for mr in data:
            if len(all_mrs) >= limit:
                break
            author = mr.get("author") or {}
            author_username = author.get("username", "unknown")

            # Skip merge requests from bot accounts
            if is_bot_account(author_username, bot_accounts):
                continue

            mr_description = mr.get("description") or ""
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

        next_page = resp.headers.get("x-next-page")
        if not next_page:
            break
        params["page"] = int(next_page)

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


def fetch_mr_diff_stats(session, project_path, mr_iid):
    """Fetch diff stats (additions/deletions) for a single merge request."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/changes"
    resp = _checked_get(session, url)
    data = resp.json()

    total_additions = 0
    total_deletions = 0
    for change in data.get("changes", []):
        diff = change.get("diff", "")
        adds, dels = count_diff_lines(diff)
        total_additions += adds
        total_deletions += dels

    return total_additions, total_deletions


def fetch_mr_comments(session, project_path, mr_iid, bot_accounts):
    """Fetch user comments for a merge request, return individual entries with timestamps."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/notes"
    params = {"per_page": 100, "page": 1}
    comments: list[dict[str, str]] = []

    while True:
        resp = _checked_get(session, url, params=params)
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


def fetch_mr_approvals(session, project_path, mr_iid, bot_accounts):
    """Fetch approvals for a merge request, return list of approvers."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/approvals"
    resp = _checked_get(session, url)
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


def _fetch_mr_details(session, jira_session, project_path, mr, bot_accounts):
    """Fetch diff stats, comments, approvals, and Jira priority for a single MR."""
    additions, deletions = fetch_mr_diff_stats(session, project_path, mr["iid"])
    mr["additions"] = additions
    mr["deletions"] = deletions
    mr["commenters"] = fetch_mr_comments(session, project_path, mr["iid"], bot_accounts)
    mr["approvers"] = fetch_mr_approvals(session, project_path, mr["iid"], bot_accounts)

    jira_key = extract_jira_key(mr["title"])
    mr["jira_key"] = jira_key
    if jira_key and jira_session:
        mr["jira_priority"] = fetch_jira_priority(jira_session, jira_key)
    else:
        mr["jira_priority"] = None

    return mr


def main():
    parser = argparse.ArgumentParser(description="Fetch GitLab merge request data.")
    parser.add_argument(
        "-n",
        "--limit",
        type=int,
        default=20,
        help="Number of most recent MRs to fetch per repo (default: 20)",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=4,
        help="Number of concurrent threads for fetching MR details (default: 4)",
    )
    parser.add_argument(
        "-r",
        "--repos",
        type=str,
        default=None,
        help=f"Path to repos configuration file (default: {DEFAULT_CONFIG_PATH})",
    )
    args = parser.parse_args()

    token = os.environ.get("GITLAB_TOKEN")
    if not token:
        print("Error: GITLAB_TOKEN environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    repos, bot_accounts, teams = load_config(args.repos)
    if not repos:
        config_file = args.repos or DEFAULT_CONFIG_PATH
        print(f"Error: No repositories found in {config_file}.", file=sys.stderr)
        sys.exit(1)

    if bot_accounts:
        bot_list = ", ".join(sorted(bot_accounts))
        print(f"Configured to ignore {len(bot_accounts)} bot accounts: {bot_list}")

    session = requests.Session()
    session.headers["PRIVATE-TOKEN"] = token

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

    for repo_cfg in repos:
        repo_url = repo_cfg["url"]
        skip_scoring = repo_cfg["skip_scoring"]
        project_path = extract_project_path(repo_url)
        print(f"Fetching up to {args.limit} MRs for {project_path}...")

        mrs = fetch_merge_requests(session, project_path, args.limit, bot_accounts)
        print(f"  Found {len(mrs)} merge requests.")

        future_to_idx = {}
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for i, mr in enumerate(mrs):
                future = executor.submit(
                    _fetch_mr_details, session, jira_session, project_path, mr, bot_accounts
                )
                future_to_idx[future] = i

            bar_fmt = (
                "  {desc}: {percentage:3.0f}%|{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}]"
            )
            with tqdm(
                total=len(mrs),
                desc=f"  {project_path}",
                unit="MR",
                bar_format=bar_fmt,
            ) as pbar:
                for future in as_completed(future_to_idx):
                    future.result()
                    pbar.update(1)

        result["repositories"].append(
            {
                "name": project_path.split("/")[-1],
                "full_path": project_path,
                "web_url": repo_url,
                "skip_scoring": skip_scoring,
                "teams": repo_cfg.get("teams", []),
                "merge_requests": mrs,
            }
        )

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"\nData written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
