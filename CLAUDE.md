# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitLab Contributions Tracker — a web dashboard that displays team-level aggregate metrics and individual contributor activity across multiple GitLab repositories. Optional Jira integration for bug priority data.

## Running the Project

```bash
# Install Python dependencies
pip install -r requirements.txt

# Fetch data (requires GITLAB_TOKEN env var; JIRA_API_TOKEN is optional)
python fetch_data.py -n 50    # Fetch 50 MRs per repo
python fetch_data.py -n 100 -w 8 -r custom-repos.yaml  # With custom options

# Command-line options:
# -n, --limit: Number of recent MRs to fetch per repo (default: 20)
# -w, --workers: Concurrent threads for fetching details (default: 4)
# -r, --repos: Path to repos configuration file (default: repos.yaml)

# Serve the frontend
cd frontend && python -m http.server 8080
```

Output is written to `frontend/data/data.json`.

## Architecture

**Backend:** `fetch_data.py` — single Python script that calls the GitLab REST API (paginated), aggregates MR data (diffs, comments, approvals), optionally fetches Jira priorities, and writes JSON output. Uses `tenacity` for retry with exponential backoff on 5xx errors.

**Frontend:** Vanilla JavaScript (`app.js`) + HTML/CSS, no build step. Uses Chart.js (CDN) for timeline visualization and jsPDF (CDN) for PDF export.

**Data flow:** `repos.yaml` → `fetch_data.py` → `frontend/data/data.json` → `app.js` renders dashboard

### Key frontend abstractions in `app.js`

- **Team aggregates**: `computeTeamAggregates()` computes 8 team-level metrics (merged MRs, median lead time, median turnaround, AI rate, AI breadth, review coverage, active contributors, lines changed) with trend indicators comparing to the previous period.
- **Timeline bucketing**: `getBucketKey()` / `buildTimelineBuckets()` group MRs by day/week/month/year. Clicking a bar filters the aggregate metrics and contributor list to that period.
- **Contributor model**: Built by `buildContributors()` which unifies MR authors, commenters, and approvers into a single object per user.
- **Contributor list**: Alphabetical, collapsible list with activity mini-badges (no ranking or scoring).

### Configuration

- `repos.yaml` — list of GitLab repository URLs to track.
- Settings: "Show All Teams" toggle and "AI Adoption Threshold" (stored in localStorage).

## Linting

Python linting is managed via tox with three environments. Run all linters:

```bash
tox
```

Or run individually:

```bash
tox -e ruff      # ruff check + format verification
tox -e mypy      # type checking
tox -e pylint    # pylint analysis
```

Configuration is in `pyproject.toml`. Key settings:
- Python 3.13 target
- Line length: 100
- Ruff rules: E, W, F, I (isort), B (bugbear), UP (pyupgrade), S (bandit security), SIM (simplify)

To auto-fix formatting: `ruff format .` and `ruff check --fix .`

CI runs these three linters via GitHub Actions on pushes and PRs to `main`.

## Build/Test

There is no build step or test suite. The frontend uses unminified vanilla JS/CSS served directly.
