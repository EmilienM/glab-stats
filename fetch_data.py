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
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "repos.yaml")

JIRA_KEY_RE = re.compile(r"([A-Z][A-Z0-9]+-\d+)")


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


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    raw = config.get("repositories", [])
    repos = []
    for entry in raw:
        if isinstance(entry, str):
            repos.append({"url": entry, "skip_scoring": []})
        else:
            repos.append(
                {
                    "url": entry["url"],
                    "skip_scoring": entry.get("skip_scoring", []),
                }
            )
    return repos


def extract_project_path(url):
    """Extract project path from a GitLab URL.

    e.g. https://gitlab.com/foo/bar -> foo/bar
    """
    url = url.rstrip("/")
    prefix = "https://gitlab.com/"
    if url.startswith(prefix):
        return url[len(prefix) :]
    raise ValueError(f"Unsupported GitLab URL: {url}")


def fetch_merge_requests(session, project_path, limit):
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
            all_mrs.append(
                {
                    "iid": mr["iid"],
                    "title": mr["title"],
                    "state": mr["state"],
                    "created_at": mr["created_at"],
                    "merged_at": mr.get("merged_at"),
                    "updated_at": mr["updated_at"],
                    "web_url": mr["web_url"],
                    "author": {
                        "username": author.get("username", "unknown"),
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


def fetch_mr_comments(session, project_path, mr_iid):
    """Fetch user comments for a merge request, return per-author counts."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/notes"
    params = {"per_page": 100, "page": 1}
    author_counts = {}

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
            if username not in author_counts:
                author_counts[username] = {
                    "username": username,
                    "name": author.get("name", "Unknown"),
                    "avatar_url": author.get("avatar_url", ""),
                    "count": 0,
                }
            author_counts[username]["count"] += 1

        next_page = resp.headers.get("x-next-page")
        if not next_page:
            break
        params["page"] = int(next_page)

    return list(author_counts.values())


def fetch_mr_approvals(session, project_path, mr_iid):
    """Fetch approvals for a merge request, return list of approvers."""
    encoded_path = quote(project_path, safe="")
    url = f"{GITLAB_API_BASE}/projects/{encoded_path}/merge_requests/{mr_iid}/approvals"
    resp = _checked_get(session, url)
    data = resp.json()

    approvers = []
    for entry in data.get("approved_by", []):
        user = entry.get("user") or {}
        approvers.append(
            {
                "username": user.get("username", "unknown"),
                "name": user.get("name", "Unknown"),
                "avatar_url": user.get("avatar_url", ""),
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


def _fetch_mr_details(session, jira_session, project_path, mr):
    """Fetch diff stats, comments, approvals, and Jira priority for a single MR."""
    additions, deletions = fetch_mr_diff_stats(session, project_path, mr["iid"])
    mr["additions"] = additions
    mr["deletions"] = deletions
    mr["commenters"] = fetch_mr_comments(session, project_path, mr["iid"])
    mr["approvers"] = fetch_mr_approvals(session, project_path, mr["iid"])

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
    args = parser.parse_args()

    token = os.environ.get("GITLAB_TOKEN")
    if not token:
        print("Error: GITLAB_TOKEN environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    repos = load_config()
    if not repos:
        print("Error: No repositories found in repos.yaml.", file=sys.stderr)
        sys.exit(1)

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
        "repositories": [],
    }

    for repo_cfg in repos:
        repo_url = repo_cfg["url"]
        skip_scoring = repo_cfg["skip_scoring"]
        project_path = extract_project_path(repo_url)
        print(f"Fetching up to {args.limit} MRs for {project_path}...")

        mrs = fetch_merge_requests(session, project_path, args.limit)
        print(f"  Found {len(mrs)} merge requests.")

        future_to_idx = {}
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for i, mr in enumerate(mrs):
                future = executor.submit(_fetch_mr_details, session, jira_session, project_path, mr)
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
                "merge_requests": mrs,
            }
        )

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"\nData written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
