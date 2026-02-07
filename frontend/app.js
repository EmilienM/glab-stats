/** GitLab Contributions Tracker — Contributor Leaderboard */

(function () {
  "use strict";

  // --- Metric registry (extensible) ---
  // Each metric receives a contributor object with:
  //   { authored_mrs, comments, approvals, username, name, avatar_url }

  // Score weights — loaded from score-config.json, overridden by localStorage
  const SCORE_DEFAULTS = {
    mr_open: 1, mr_merged: 10, comment: 3, approval: 2,
    line_added: 0.05, line_deleted: 0.02,
    priority_critical: 15, priority_major: 8, priority_normal: 3, priority_minor: 1, priority_undefined: 0,
  };
  let SCORE_FILE = { ...SCORE_DEFAULTS };
  let SCORE = { ...SCORE_DEFAULTS };

  const SCORE_STORAGE_KEY = "score-config-overrides";

  async function loadScoreConfig() {
    try {
      const resp = await fetch("score-config.json");
      if (resp.ok) {
        SCORE_FILE = await resp.json();
      }
    } catch (_) {
      // keep defaults
    }
    // Apply localStorage overrides on top of file values
    const saved = localStorage.getItem(SCORE_STORAGE_KEY);
    if (saved) {
      try {
        SCORE = { ...SCORE_FILE, ...JSON.parse(saved) };
      } catch (_) {
        SCORE = { ...SCORE_FILE };
      }
    } else {
      SCORE = { ...SCORE_FILE };
    }
  }

  function priorityScoreKey(priority) {
    if (!priority) return "priority_undefined";
    const p = priority.toLowerCase();
    if (p === "critical") return "priority_critical";
    if (p === "major") return "priority_major";
    if (p === "normal") return "priority_normal";
    if (p === "minor") return "priority_minor";
    return "priority_undefined";
  }

  function computePriorityPoints(mrs) {
    let pts = 0;
    for (const mr of mrs) {
      if (!mr.jira_key) continue;
      pts += SCORE[priorityScoreKey(mr.jira_priority)] || 0;
    }
    return pts;
  }

  function computeScore(c) {
    const merged = c.authored_mrs.filter((mr) => mr.state === "merged").length;
    const nonMerged = c.authored_mrs.length - merged;
    const adds = c.authored_mrs.reduce((s, mr) => s + (mr.additions || 0), 0);
    const dels = c.authored_mrs.reduce((s, mr) => s + (mr.deletions || 0), 0);
    const prioPoints = computePriorityPoints(c.authored_mrs);
    return Math.round(
      (nonMerged * SCORE.mr_open)
      + (merged * SCORE.mr_merged)
      + (c.comments * SCORE.comment)
      + (c.approvals * SCORE.approval)
      + (adds * SCORE.line_added)
      + (dels * SCORE.line_deleted)
      + prioPoints
    );
  }

  const METRICS = [
    {
      id: "score",
      label: "Score",
      compute: computeScore,
      breakdown: (c) => {
        const merged = c.authored_mrs.filter((mr) => mr.state === "merged").length;
        const nonMerged = c.authored_mrs.length - merged;
        const adds = c.authored_mrs.reduce((s, mr) => s + (mr.additions || 0), 0);
        const dels = c.authored_mrs.reduce((s, mr) => s + (mr.deletions || 0), 0);
        const p = [];
        const mrPts = (nonMerged * SCORE.mr_open) + (merged * SCORE.mr_merged);
        const commentPts = c.comments * SCORE.comment;
        const approvalPts = c.approvals * SCORE.approval;
        const linePts = Math.round((adds * SCORE.line_added) + (dels * SCORE.line_deleted));
        const prioPts = computePriorityPoints(c.authored_mrs);
        if (mrPts) p.push({ label: `${mrPts} MRs`, css: "mini-badge-merged" });
        if (linePts) p.push({ label: `${linePts} lines`, css: "mini-badge-opened" });
        if (commentPts) p.push({ label: `${commentPts} comments`, css: "mini-badge-opened" });
        if (approvalPts) p.push({ label: `${approvalPts} approvals`, css: "mini-badge-closed" });
        if (prioPts) p.push({ label: `${prioPts} priority`, css: "mini-badge-merged" });
        return p;
      },
    },
    {
      id: "total_mrs",
      label: "Total MRs",
      compute: (c) => c.authored_mrs.length,
      breakdown: (c) => {
        const m = c.authored_mrs.filter((mr) => mr.state === "merged").length;
        const o = c.authored_mrs.filter((mr) => mr.state === "opened").length;
        const cl = c.authored_mrs.filter((mr) => mr.state === "closed").length;
        const p = [];
        if (m) p.push({ label: `${m} merged`, css: "mini-badge-merged" });
        if (o) p.push({ label: `${o} open`, css: "mini-badge-opened" });
        if (cl) p.push({ label: `${cl} closed`, css: "mini-badge-closed" });
        return p;
      },
    },
    {
      id: "merged_mrs",
      label: "Merged MRs",
      compute: (c) => c.authored_mrs.filter((mr) => mr.state === "merged").length,
      breakdown: (c) => {
        const total = c.authored_mrs.length;
        const m = c.authored_mrs.filter((mr) => mr.state === "merged").length;
        return [{ label: `${m} of ${total} MRs`, css: "mini-badge-merged" }];
      },
    },
    {
      id: "open_mrs",
      label: "Open MRs",
      compute: (c) => c.authored_mrs.filter((mr) => mr.state === "opened").length,
      breakdown: (c) => {
        const total = c.authored_mrs.length;
        const o = c.authored_mrs.filter((mr) => mr.state === "opened").length;
        return [{ label: `${o} of ${total} MRs`, css: "mini-badge-opened" }];
      },
    },
    {
      id: "lines_added",
      label: "Lines Added",
      compute: (c) => c.authored_mrs.reduce((s, mr) => s + (mr.additions || 0), 0),
      breakdown: (c) => {
        const adds = c.authored_mrs.reduce((s, mr) => s + (mr.additions || 0), 0);
        const dels = c.authored_mrs.reduce((s, mr) => s + (mr.deletions || 0), 0);
        const p = [];
        if (adds) p.push({ label: `+${adds.toLocaleString()}`, css: "mini-badge-merged" });
        if (dels) p.push({ label: `\u2212${dels.toLocaleString()}`, css: "mini-badge-closed" });
        return p;
      },
    },
    {
      id: "lines_changed",
      label: "Lines Changed",
      compute: (c) => c.authored_mrs.reduce((s, mr) => s + (mr.additions || 0) + (mr.deletions || 0), 0),
      breakdown: (c) => {
        const adds = c.authored_mrs.reduce((s, mr) => s + (mr.additions || 0), 0);
        const dels = c.authored_mrs.reduce((s, mr) => s + (mr.deletions || 0), 0);
        const p = [];
        if (adds) p.push({ label: `+${adds.toLocaleString()}`, css: "mini-badge-merged" });
        if (dels) p.push({ label: `\u2212${dels.toLocaleString()}`, css: "mini-badge-closed" });
        return p;
      },
    },
    {
      id: "comments",
      label: "Comments",
      compute: (c) => c.comments,
      breakdown: (c) => {
        const onOwn = c.commentsOnOwn;
        const onOthers = c.comments - onOwn;
        const p = [];
        if (onOthers) p.push({ label: `${onOthers} on others`, css: "mini-badge-merged" });
        if (onOwn) p.push({ label: `${onOwn} on own`, css: "mini-badge-opened" });
        return p;
      },
    },
    {
      id: "approvals",
      label: "Approvals",
      compute: (c) => c.approvals,
      breakdown: (c) => {
        const p = [];
        if (c.approvals) p.push({ label: `${c.approvals} given`, css: "mini-badge-merged" });
        return p;
      },
    },
    {
      id: "bug_priority",
      label: "Bug Priority",
      compute: (c) => computePriorityPoints(c.authored_mrs),
      breakdown: (c) => {
        const counts = { Critical: 0, Major: 0, Normal: 0, Minor: 0, Undefined: 0 };
        for (const mr of c.authored_mrs) {
          if (!mr.jira_key) continue;
          const key = priorityScoreKey(mr.jira_priority);
          if (key === "priority_critical") counts.Critical++;
          else if (key === "priority_major") counts.Major++;
          else if (key === "priority_normal") counts.Normal++;
          else if (key === "priority_minor") counts.Minor++;
          else counts.Undefined++;
        }
        const p = [];
        if (counts.Critical) p.push({ label: `${counts.Critical} critical`, css: "mini-badge-closed" });
        if (counts.Major) p.push({ label: `${counts.Major} major`, css: "mini-badge-opened" });
        if (counts.Normal) p.push({ label: `${counts.Normal} normal`, css: "mini-badge-merged" });
        if (counts.Minor) p.push({ label: `${counts.Minor} minor`, css: "mini-badge-merged" });
        if (counts.Undefined) p.push({ label: `${counts.Undefined} undefined`, css: "mini-badge-merged" });
        return p;
      },
    },
  ];

  // --- State ---
  let allMRs = [];
  let repositories = [];
  let generatedAt = "";

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const loadingEl = $("#loading");
  const errorEl = $("#error");
  const appEl = $("#app");
  const leaderboardBody = $("#leaderboard-body");
  const leaderboardPeriod = $("#leaderboard-period");
  const filterRepo = $("#filter-repo");
  const metricSelect = $("#metric-select");
  const generatedAtEl = $("#generated-at");
  const themeToggle = $("#theme-toggle");
  const themeIcon = $("#theme-icon");
  const timelineCanvas = $("#timeline-chart");
  const granularityToggle = $("#granularity-toggle");
  const scoreLegendEl = $("#score-legend");
  const scoreLegendItems = $("#score-legend-items");
  let timelineChart = null;
  const detailOverlay = $("#detail-overlay");
  const detailClose = $("#detail-close");
  const detailAvatar = $("#detail-avatar");
  const detailName = $("#detail-name");
  const detailUsername = $("#detail-username");
  const detailMetrics = $("#detail-metrics");
  const detailRepos = $("#detail-repos");
  const detailMRs = $("#detail-mrs");
  const detailChartsEl = $("#detail-charts");
  const detailGranToggle = $("#detail-gran-toggle");
  let detailCharts = [];
  let detailGranularity = "month";
  let detailCurrentUsername = null;
  let currentGranularity = "week";
  let selectedPeriodKey = null;   // null = current period, string = a specific bucket key
  let timelineBucketKeys = [];    // raw keys for each bar index

  // --- Theme ---
  function initTheme() {
    const saved = localStorage.getItem("theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeIcon(saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    updateThemeIcon(next);
    // Re-render chart with new theme colors
    if (appEl && !appEl.hidden) render();
  }

  function updateThemeIcon(theme) {
    themeIcon.textContent = theme === "dark" ? "\u263E" : "\u2600";
  }

  themeToggle.addEventListener("click", toggleTheme);
  initTheme();

  // --- Populate metric selector ---
  function populateMetrics() {
    for (const metric of METRICS) {
      const opt = document.createElement("option");
      opt.value = metric.id;
      opt.textContent = metric.label;
      metricSelect.appendChild(opt);
    }
  }
  populateMetrics();

  // --- Data Loading ---
  async function loadData() {
    try {
      const resp = await fetch("data/data.json");
      if (!resp.ok) throw new Error(`Failed to load data (${resp.status})`);
      const data = await resp.json();

      repositories = data.repositories || [];
      generatedAt = data.generated_at || "";

      allMRs = [];
      for (const repo of repositories) {
        const skip = new Set(repo.skip_scoring || []);
        for (const mr of repo.merge_requests) {
          allMRs.push({
            ...mr,
            repoName: repo.name,
            repoPath: repo.full_path,
            skipScoring: skip,
          });
        }
      }

      loadingEl.hidden = true;
      appEl.hidden = false;

      populateFilters();
      render();
    } catch (err) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = `Error: ${err.message}. Make sure you have run fetch_data.py first.`;
    }
  }

  // --- Filters ---
  function repoDisplayLabel(fullPath) {
    // Show short name if unique, otherwise add parent segments to disambiguate
    const parts = fullPath.split("/");
    const name = parts[parts.length - 1];
    const dupes = repositories.filter((r) => r.name === name);
    if (dupes.length <= 1) return name;
    // Use last 2 segments (e.g. "rhaiis/pipeline" vs "rhai/pipeline")
    return parts.slice(-2).join("/");
  }

  function populateFilters() {
    const paths = [...new Set(repositories.map((r) => r.full_path))].sort();
    for (const path of paths) {
      const opt = document.createElement("option");
      opt.value = path;
      opt.textContent = repoDisplayLabel(path);
      filterRepo.appendChild(opt);
    }
  }

  function getFilteredMRs() {
    const repo = filterRepo.value;
    if (!repo) return allMRs;
    return allMRs.filter((mr) => mr.repoPath === repo);
  }

  filterRepo.addEventListener("change", render);
  metricSelect.addEventListener("change", render);

  // Granularity toggle
  granularityToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".gran-btn");
    if (!btn) return;
    granularityToggle.querySelectorAll(".gran-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentGranularity = btn.dataset.gran;
    selectedPeriodKey = null;
    render();
  });

  // --- Contributor detail click ---
  leaderboardBody.addEventListener("click", (e) => {
    const row = e.target.closest(".lb-row");
    if (!row) return;
    const username = row.dataset.username;
    if (username) openContributorDetail(username);
  });

  // --- Time-period filter for leaderboard ---
  function currentPeriodKey(gran) {
    const now = new Date();
    const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (gran === "day") return toKey(nowUTC);
    if (gran === "week") return toKey(mondayOf(nowUTC));
    if (gran === "month") return toKey(nowUTC).slice(0, 7);
    if (gran === "year") return String(nowUTC.getUTCFullYear());
    return null;
  }

  function filterMRsToPeriod(mrs, gran, periodKey) {
    if (!periodKey) return mrs;
    return mrs.filter((mr) => getBucketKey(mr.created_at, gran) === periodKey);
  }

  function periodLabel(gran, periodKey) {
    const curKey = currentPeriodKey(gran);
    if (periodKey === curKey) {
      if (gran === "day") return "today";
      if (gran === "week") return "this week";
      if (gran === "month") return "this month";
      if (gran === "year") return "this year";
    }
    return formatBucketLabel(periodKey, gran);
  }

  // --- Build contributor data ---
  function ensureContributor(map, user) {
    if (!map.has(user.username)) {
      map.set(user.username, {
        username: user.username,
        name: user.name,
        avatar_url: user.avatar_url,
        authored_mrs: [],
        comments: 0,
        commentsOnOwn: 0,
        approvals: 0,
      });
    }
    return map.get(user.username);
  }

  function buildContributors(mrs) {
    const map = new Map();

    for (const mr of mrs) {
      const skip = mr.skipScoring || new Set();

      // MR author — if lines are skipped for this repo, zero out line stats
      const mrForAuthor = skip.has("lines")
        ? { ...mr, additions: 0, deletions: 0 }
        : mr;
      const author = ensureContributor(map, mr.author);
      author.authored_mrs.push(mrForAuthor);

      // Commenters (skip if this repo excludes comment scoring)
      if (!skip.has("comments")) {
        for (const c of (mr.commenters || [])) {
          const contributor = ensureContributor(map, c);
          contributor.comments += c.count;
          if (c.username === mr.author.username) {
            contributor.commentsOnOwn += c.count;
          }
        }
      }

      // Approvers (skip if this repo excludes approval scoring)
      if (!skip.has("approvals")) {
        for (const a of (mr.approvers || [])) {
          const contributor = ensureContributor(map, a);
          contributor.approvals += 1;
        }
      }
    }

    return [...map.values()];
  }

  // --- Rendering ---
  function render(skipTimeline) {
    const allFiltered = getFilteredMRs();
    const activePeriod = selectedPeriodKey || currentPeriodKey(currentGranularity);
    const periodMRs = filterMRsToPeriod(allFiltered, currentGranularity, activePeriod);
    const metric = METRICS.find((m) => m.id === metricSelect.value) || METRICS[0];
    const contributors = buildContributors(periodMRs);

    // Compute metric and breakdown for each contributor
    for (const c of contributors) {
      c.score = metric.compute(c);
      c.breakdownBadges = metric.breakdown(c);
    }

    // Sort descending by score, drop zero-score contributors
    contributors.sort((a, b) => b.score - a.score);
    const active = contributors.filter((c) => c.score > 0);

    leaderboardPeriod.textContent = `Showing contributors for ${periodLabel(currentGranularity, activePeriod)} (${periodMRs.length} MRs)`;

    if (generatedAt) {
      generatedAtEl.textContent = `Data from ${new Date(generatedAt).toLocaleString()}`;
    }

    renderScoreLegend(metric);
    if (!skipTimeline) renderTimeline(allFiltered);
    renderLeaderboard(active);
  }

  function scoreLegendEntries() {
    return [
      { value: SCORE.mr_merged, label: "per merged MR" },
      { value: SCORE.mr_open, label: "per opened MR" },
      { value: SCORE.comment, label: "per comment" },
      { value: SCORE.approval, label: "per approval" },
      { value: SCORE.line_added, label: "per line added" },
      { value: SCORE.line_deleted, label: "per line deleted" },
      { value: SCORE.priority_critical, label: "per critical bug" },
      { value: SCORE.priority_major, label: "per major bug" },
      { value: SCORE.priority_normal, label: "per normal bug" },
      { value: SCORE.priority_minor, label: "per minor bug" },
    ].filter((e) => e.value);
  }

  function renderScoreLegend(metric) {
    if (metric.id !== "score") {
      scoreLegendEl.hidden = true;
      return;
    }
    scoreLegendEl.hidden = false;
    const entries = scoreLegendEntries();
    scoreLegendItems.innerHTML = entries.map((e) =>
      `<span class="score-legend-item"><span class="sl-value">${e.value}</span> <span class="sl-label">${e.label}</span></span>`
    ).join(`<span class="score-legend-item sl-sep">&middot;</span>`);
  }

  function renderLeaderboard(contributors) {
    if (contributors.length === 0) {
      leaderboardBody.innerHTML = `
        <div class="empty-state">
          <p>No contributors found</p>
          <small>Try adjusting the filters</small>
        </div>`;
      return;
    }

    const maxScore = contributors[0].score || 1;

    leaderboardBody.innerHTML = contributors.map((c, i) => {
      const rank = i + 1;
      const pct = Math.round((c.score / maxScore) * 100);
      const rankClass = rank <= 3 ? ` rank-${rank}` : "";
      const avatarHtml = c.avatar_url
        ? `<img class="lb-avatar" src="${escapeHtml(c.avatar_url)}" alt="" loading="lazy">`
        : `<div class="lb-avatar-placeholder">${escapeHtml(c.name.charAt(0).toUpperCase())}</div>`;

      return `
        <div class="lb-row" data-username="${escapeHtml(c.username)}">
          <span class="lb-rank${rankClass}">${rank}</span>
          <div class="lb-contributor">
            ${avatarHtml}
            <div class="lb-name-block">
              <span class="lb-name">${escapeHtml(c.name)}</span>
              <span class="lb-username">@${escapeHtml(c.username)}</span>
            </div>
          </div>
          <div class="lb-bar-cell" title="${pct}% of top contributor">
            <div class="lb-bar-track">
              <div class="lb-bar-fill" style="width: ${pct}%"></div>
            </div>
            <span class="lb-bar-pct">${pct}%</span>
          </div>
          <div class="lb-breakdown">
            ${c.breakdownBadges.map((b) => `<span class="mini-badge ${b.css}">${b.label}</span>`).join("")}
          </div>
          <span class="lb-value">${c.score}</span>
        </div>`;
    }).join("");
  }

  // --- Timeline ---

  // All date helpers use UTC to stay consistent with GitLab timestamps.
  function utcDate(iso) {
    const d = new Date(iso);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  function toKey(d) {
    // d is already a UTC-midnight Date
    return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
  }

  function mondayOf(d) {
    const tmp = new Date(d.getTime());
    const dow = tmp.getUTCDay() || 7; // Sun=0 -> 7
    tmp.setUTCDate(tmp.getUTCDate() - dow + 1);
    return tmp;
  }

  function getBucketKey(iso, gran) {
    const d = utcDate(iso);
    if (gran === "day") return toKey(d);
    if (gran === "week") return toKey(mondayOf(d));
    if (gran === "month") return toKey(d).slice(0, 7); // "YYYY-MM"
    return String(d.getUTCFullYear()); // "YYYY"
  }

  function advanceBucket(key, gran) {
    // Given a bucket key, return the next bucket key
    if (gran === "day") {
      const d = new Date(key + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      return toKey(d);
    }
    if (gran === "week") {
      const d = new Date(key + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 7);
      return toKey(d);
    }
    if (gran === "month") {
      const [y, m] = key.split("-").map(Number);
      const next = new Date(Date.UTC(y, m, 1)); // month is 0-indexed, so m (already 1-based) = next month
      return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    }
    // year
    return String(Number(key) + 1);
  }

  const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function formatBucketLabel(key, gran) {
    if (gran === "year") return key;
    if (gran === "month") {
      const [y, m] = key.split("-");
      return `${SHORT_MONTHS[parseInt(m, 10) - 1]} ${y}`;
    }
    if (gran === "week") {
      const mon = new Date(key + "T00:00:00Z");
      const sun = new Date(mon.getTime());
      sun.setUTCDate(sun.getUTCDate() + 6);
      const mLabel = `${SHORT_MONTHS[mon.getUTCMonth()]} ${mon.getUTCDate()}`;
      const sLabel = `${SHORT_MONTHS[sun.getUTCMonth()]} ${sun.getUTCDate()}`;
      return `${mLabel} – ${sLabel}`;
    }
    // day
    const d = new Date(key + "T00:00:00Z");
    return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  function buildTimelineBuckets(mrs, gran) {
    if (mrs.length === 0) {
      return { keys: [], labels: [], merged: [], opened: [], closed: [] };
    }

    // Bucket the MRs
    const buckets = new Map();
    for (const mr of mrs) {
      const key = getBucketKey(mr.created_at, gran);
      if (!buckets.has(key)) {
        buckets.set(key, { merged: 0, opened: 0, closed: 0 });
      }
      const b = buckets.get(key);
      if (mr.state === "merged") b.merged++;
      else if (mr.state === "opened") b.opened++;
      else if (mr.state === "closed") b.closed++;
    }

    // Find min/max bucket keys
    const keys = [...buckets.keys()].sort();
    const minKey = keys[0];
    const maxKey = keys[keys.length - 1];

    // Fill in all intermediate empty buckets
    const filled = [];
    let cur = minKey;
    while (cur <= maxKey) {
      const val = buckets.get(cur) || { merged: 0, opened: 0, closed: 0 };
      filled.push([cur, val]);
      cur = advanceBucket(cur, gran);
    }

    return {
      keys: filled.map(([k]) => k),
      labels: filled.map(([k]) => formatBucketLabel(k, gran)),
      merged: filled.map(([, v]) => v.merged),
      opened: filled.map(([, v]) => v.opened),
      closed: filled.map(([, v]) => v.closed),
    };
  }

  function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      merged: style.getPropertyValue("--stat-merged-border").trim(),
      opened: style.getPropertyValue("--stat-opened-border").trim(),
      closed: style.getPropertyValue("--stat-closed-border").trim(),
      grid: style.getPropertyValue("--border").trim(),
      text: style.getPropertyValue("--text-secondary").trim(),
    };
  }

  function renderTimeline(mrs) {
    const data = buildTimelineBuckets(mrs, currentGranularity);
    timelineBucketKeys = data.keys;
    const colors = getChartColors();
    const activePeriod = selectedPeriodKey || currentPeriodKey(currentGranularity);

    // Highlight the selected bar, dim others
    function barColors(baseColor, keys) {
      if (!activePeriod) return baseColor;
      return keys.map((k) => k === activePeriod ? baseColor : baseColor + "40");
    }

    if (timelineChart) {
      timelineChart.destroy();
    }

    timelineChart = new Chart(timelineCanvas, {
      type: "bar",
      data: {
        labels: data.labels,
        datasets: [
          {
            label: "Merged",
            data: data.merged,
            backgroundColor: barColors(colors.merged, data.keys),
            borderRadius: 3,
          },
          {
            label: "Open",
            data: data.opened,
            backgroundColor: barColors(colors.opened, data.keys),
            borderRadius: 3,
          },
          {
            label: "Closed",
            data: data.closed,
            backgroundColor: barColors(colors.closed, data.keys),
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        onClick: (_event, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          const clickedKey = timelineBucketKeys[idx];
          // Toggle: click same bar again to deselect
          selectedPeriodKey = selectedPeriodKey === clickedKey ? null : clickedKey;
          render();
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: colors.text,
              boxWidth: 12,
              padding: 16,
              font: { size: 11, weight: "600" },
            },
          },
          tooltip: {
            backgroundColor: "rgba(0,0,0,0.8)",
            titleFont: { size: 12 },
            bodyFont: { size: 11 },
            padding: 10,
            cornerRadius: 6,
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            ticks: {
              color: colors.text,
              font: { size: 10 },
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: 20,
            },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: colors.grid },
            ticks: {
              color: colors.text,
              font: { size: 10 },
              precision: 0,
            },
          },
        },
      },
    });
  }

  // --- PDF Export ---
  const exportBtn = $("#export-pdf");
  const exportIndividualBtn = $("#export-individual-pdf");

  exportBtn.addEventListener("click", () => {
    exportBtn.disabled = true;
    exportBtn.textContent = "...";

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      let y = 15;

      // Title
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("GitLab Contributions Report", 14, y);
      y += 8;

      // Metadata line
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      const metricLabel = metricSelect.options[metricSelect.selectedIndex].text;
      const repoLabel = filterRepo.value || "All Repositories";
      const activePeriod = selectedPeriodKey || currentPeriodKey(currentGranularity);
      const period = periodLabel(currentGranularity, activePeriod);
      const genDate = generatedAt ? new Date(generatedAt).toLocaleString() : "N/A";
      doc.text(`Ranked by: ${metricLabel}  |  Repository: ${repoLabel}  |  Period: ${period}  |  Data from: ${genDate}`, 14, y);
      doc.setTextColor(0);
      y += 6;

      // Score legend (only when metric is Score)
      const currentMetric = METRICS.find((m) => m.id === metricSelect.value) || METRICS[0];
      if (currentMetric.id === "score") {
        const entries = scoreLegendEntries();
        doc.setFontSize(8);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(120);
        const legendText = "Scoring: " + entries.map((e) => `${e.value} ${e.label}`).join("  |  ");
        doc.text(legendText, 14, y);
        doc.setTextColor(0);
        y += 5;
      }

      // Separator
      doc.setDrawColor(200);
      doc.line(14, y, pageW - 14, y);
      y += 6;

      // Chart image
      if (timelineChart) {
        const chartImg = timelineCanvas.toDataURL("image/png", 1.0);
        const chartW = pageW - 28;
        const chartH = 50;
        doc.addImage(chartImg, "PNG", 14, y, chartW, chartH);
        y += chartH + 8;
      }

      // Build table data from current leaderboard
      const allFiltered = getFilteredMRs();
      const periodMRs = filterMRsToPeriod(allFiltered, currentGranularity, activePeriod);
      const metric = METRICS.find((m) => m.id === metricSelect.value) || METRICS[0];
      const contributors = buildContributors(periodMRs);
      for (const c of contributors) {
        c.score = metric.compute(c);
        c.breakdownBadges = metric.breakdown(c);
      }
      contributors.sort((a, b) => b.score - a.score);
      const active = contributors.filter((c) => c.score > 0);

      const maxScore = active.length ? active[0].score : 1;
      const tableHead = [["#", "Contributor", "Username", "Relative", "Breakdown", metricLabel]];
      const tableBody = active.map((c, i) => {
        const pct = Math.round((c.score / maxScore) * 100);
        const breakdown = c.breakdownBadges.map((b) => b.label).join(", ");
        return [
          i + 1,
          c.name,
          `@${c.username}`,
          `${pct}%`,
          breakdown,
          c.score.toLocaleString(),
        ];
      });

      doc.autoTable({
        startY: y,
        head: tableHead,
        body: tableBody,
        margin: { left: 14, right: 14 },
        styles: { fontSize: 8, cellPadding: 2.5 },
        headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          0: { halign: "center", cellWidth: 10 },
          3: { halign: "center", cellWidth: 20 },
          5: { halign: "right", cellWidth: 22, fontStyle: "bold" },
        },
        alternateRowStyles: { fillColor: [245, 245, 250] },
      });

      // Footer
      const finalY = doc.lastAutoTable.finalY + 8;
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Generated on ${new Date().toLocaleString()} — GitLab Contributions Tracker`, 14, finalY);

      const filename = `contributions-${metricLabel.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.pdf`;
      doc.save(filename);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = "PDF";
    }
  });

  // --- Individual PDF Export ---
  exportIndividualBtn.addEventListener("click", () => {
    if (!detailCurrentUsername) return;

    exportIndividualBtn.disabled = true;
    exportIndividualBtn.textContent = "...";

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      let y = 15;

      // Get contributor data
      const mrs = getFilteredMRs();
      const contributors = buildContributors(mrs);
      const contributor = contributors.find((c) => c.username === detailCurrentUsername);
      if (!contributor) return;

      // Calculate metrics for the contributor
      for (const metric of METRICS) {
        contributor[`metric_${metric.id}`] = metric.compute(contributor);
      }

      // Title
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Individual Contributor Report", 14, y);
      y += 8;

      // Contributor name and username
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text(`${contributor.name} (@${contributor.username})`, 14, y);
      y += 6;

      // Metadata line
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      const repoLabel = filterRepo.value || "All Repositories";
      const genDate = generatedAt ? new Date(generatedAt).toLocaleString() : "N/A";
      doc.text(`Repository: ${repoLabel}  |  Data from: ${genDate}`, 14, y);
      doc.setTextColor(0);
      y += 6;

      // Separator
      doc.setDrawColor(200);
      doc.line(14, y, pageW - 14, y);
      y += 8;

      // Metrics summary
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("Metrics Summary", 14, y);
      y += 6;

      // Create metrics table
      const metricsData = METRICS.map(metric => [
        metric.label,
        contributor[`metric_${metric.id}`].toLocaleString()
      ]);

      doc.autoTable({
        startY: y,
        head: [["Metric", "Value"]],
        body: metricsData,
        margin: { left: 14, right: 14 },
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          1: { halign: "right", fontStyle: "bold" }
        },
        alternateRowStyles: { fillColor: [245, 245, 250] },
      });

      y = doc.lastAutoTable.finalY + 8;

      // Repository breakdown
      if (y > pageH - 40) {
        doc.addPage();
        y = 15;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("Repository Breakdown", 14, y);
      y += 6;

      const repoMap = new Map();
      for (const mr of contributor.authored_mrs) {
        if (!repoMap.has(mr.repoName)) {
          repoMap.set(mr.repoName, { count: 0, merged: 0, adds: 0, dels: 0 });
        }
        const r = repoMap.get(mr.repoName);
        r.count++;
        if (mr.state === "merged") r.merged++;
        r.adds += mr.additions || 0;
        r.dels += mr.deletions || 0;
      }

      const repoData = [...repoMap.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, stats]) => [
          name,
          stats.count.toString(),
          stats.merged.toString(),
          `+${stats.adds.toLocaleString()}`,
          `-${stats.dels.toLocaleString()}`
        ]);

      if (repoData.length > 0) {
        doc.autoTable({
          startY: y,
          head: [["Repository", "Total MRs", "Merged", "Additions", "Deletions"]],
          body: repoData,
          margin: { left: 14, right: 14 },
          styles: { fontSize: 8, cellPadding: 2.5 },
          headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: "bold" },
          columnStyles: {
            1: { halign: "center" },
            2: { halign: "center" },
            3: { halign: "right", textColor: [34, 139, 34] },
            4: { halign: "right", textColor: [220, 20, 60] }
          },
          alternateRowStyles: { fillColor: [245, 245, 250] },
        });

        y = doc.lastAutoTable.finalY + 8;
      }

      // Recent merge requests
      if (y > pageH - 40) {
        doc.addPage();
        y = 15;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("Recent Merge Requests", 14, y);
      y += 6;

      const recentMRs = [...contributor.authored_mrs]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 15);

      if (recentMRs.length > 0) {
        const mrData = recentMRs.map(mr => {
          const d = new Date(mr.created_at);
          const dateStr = `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
          return [
            mr.title.length > 45 ? mr.title.substring(0, 42) + "..." : mr.title,
            mr.state,
            mr.repoName.length > 20 ? mr.repoName.substring(0, 17) + "..." : mr.repoName,
            dateStr
          ];
        });

        doc.autoTable({
          startY: y,
          head: [["Title", "Status", "Repository", "Created"]],
          body: mrData,
          margin: { left: 14, right: 14 },
          styles: { fontSize: 7, cellPadding: 2 },
          headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: "bold" },
          columnStyles: {
            1: { halign: "center" },
            3: { halign: "center" }
          },
          alternateRowStyles: { fillColor: [245, 245, 250] },
        });

        y = doc.lastAutoTable.finalY + 8;
      }

      // Footer
      if (y > pageH - 20) {
        doc.addPage();
        y = pageH - 15;
      } else {
        y = pageH - 15;
      }
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Generated on ${new Date().toLocaleString()} — GitLab Contributions Tracker`, 14, y);

      const filename = `contributor-${contributor.username}-${new Date().toISOString().slice(0, 10)}.pdf`;
      doc.save(filename);
    } catch (error) {
      console.error("Error generating PDF:", error);
      alert("Error generating PDF. Please try again.");
    } finally {
      exportIndividualBtn.disabled = false;
      exportIndividualBtn.textContent = "PDF";
    }
  });

  // --- Settings Modal ---
  const SCORE_LABELS = {
    mr_merged: "Merged MR",
    mr_open: "Opened MR (not merged)",
    comment: "Comment",
    approval: "Approval",
    line_added: "Line added",
    line_deleted: "Line deleted",
    priority_critical: "Critical bug fix",
    priority_major: "Major bug fix",
    priority_normal: "Normal bug fix",
    priority_minor: "Minor bug fix",
    priority_undefined: "Undefined priority",
  };

  const settingsBtn = $("#btn-settings");
  const settingsOverlay = $("#settings-overlay");
  const settingsBody = $("#settings-body");
  const settingsClose = $("#settings-close");
  const settingsSave = $("#settings-save");
  const settingsReset = $("#settings-reset");

  function hasCustomOverrides() {
    return localStorage.getItem(SCORE_STORAGE_KEY) !== null;
  }

  function openSettings() {
    settingsBody.innerHTML = "";
    const keys = Object.keys(SCORE_LABELS);
    for (const key of keys) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const val = SCORE[key] ?? SCORE_FILE[key] ?? 0;
      const isCustom = hasCustomOverrides() && SCORE[key] !== SCORE_FILE[key];
      row.innerHTML =
        `<label class="setting-label" for="sc-${key}">${SCORE_LABELS[key]}${isCustom ? '<span class="modal-custom-badge">custom</span>' : ''}</label>` +
        `<input class="setting-input" id="sc-${key}" type="number" step="any" data-key="${key}" value="${val}">`;
      settingsBody.appendChild(row);
    }
    settingsOverlay.hidden = false;
  }

  function closeSettings() {
    settingsOverlay.hidden = true;
  }

  function saveSettings() {
    const inputs = settingsBody.querySelectorAll(".setting-input");
    const overrides = {};
    for (const input of inputs) {
      overrides[input.dataset.key] = parseFloat(input.value) || 0;
    }
    localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(overrides));
    SCORE = { ...SCORE_FILE, ...overrides };
    closeSettings();
    render();
  }

  function resetSettings() {
    localStorage.removeItem(SCORE_STORAGE_KEY);
    SCORE = { ...SCORE_FILE };
    closeSettings();
    render();
  }

  settingsBtn.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingsSave.addEventListener("click", saveSettings);
  settingsReset.addEventListener("click", resetSettings);
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  // --- Contributor Detail Modal ---
  function openContributorDetail(username) {
    const mrs = getFilteredMRs();
    const contributors = buildContributors(mrs);
    const contributor = contributors.find((c) => c.username === username);
    if (!contributor) return;

    // Header
    if (contributor.avatar_url) {
      detailAvatar.src = contributor.avatar_url;
      detailAvatar.hidden = false;
    } else {
      detailAvatar.hidden = true;
    }
    detailName.textContent = contributor.name;
    detailUsername.textContent = `@${contributor.username}`;

    detailCurrentUsername = username;
    renderDetailMetrics(contributor);
    renderDetailCharts(username, detailGranularity);
    renderDetailRepos(contributor);
    renderDetailMRs(contributor);

    detailOverlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeContributorDetail() {
    detailOverlay.hidden = true;
    document.body.style.overflow = "";
    for (const chart of detailCharts) chart.destroy();
    detailCharts = [];
    detailCurrentUsername = null;
  }

  function renderDetailMetrics(contributor) {
    detailMetrics.innerHTML = METRICS.map((m) => {
      const val = m.compute(contributor);
      return `<div class="detail-metric-card">
        <div class="detail-metric-value">${val.toLocaleString()}</div>
        <div class="detail-metric-label">${escapeHtml(m.label)}</div>
      </div>`;
    }).join("");
  }

  // Maps the period toggle to a fixed time range and bucket granularity.
  // "week"  → last 7 days,    daily   buckets
  // "month" → last ~4 weeks,  weekly  buckets
  // "year"  → last 12 months, monthly buckets
  function getDetailRange(period) {
    const now = new Date();
    const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (period === "week") {
      const start = new Date(nowUTC);
      start.setUTCDate(start.getUTCDate() - 6);
      return { gran: "day", startKey: toKey(start), endKey: toKey(nowUTC) };
    }
    if (period === "month") {
      const curMonday = mondayOf(nowUTC);
      const start = new Date(curMonday);
      start.setUTCDate(start.getUTCDate() - 21); // 3 weeks back → 4 weeks total
      return { gran: "week", startKey: toKey(start), endKey: toKey(curMonday) };
    }
    // year → last 12 months
    const endKey = `${nowUTC.getUTCFullYear()}-${String(nowUTC.getUTCMonth() + 1).padStart(2, "0")}`;
    const startDate = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() - 11, 1));
    const startKey = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;
    return { gran: "month", startKey, endKey };
  }

  function computePerBucketData(username, allMRsFiltered, gran, startKey, endKey) {
    const bucketData = new Map();

    function ensure(key) {
      if (!bucketData.has(key)) {
        bucketData.set(key, { authored: 0, merged: 0, comments: 0, approvals: 0, adds: 0, dels: 0, priorityPts: 0 });
      }
      return bucketData.get(key);
    }

    for (const mr of allMRsFiltered) {
      const key = getBucketKey(mr.created_at, gran);
      if (key < startKey || key > endKey) continue;
      const skip = mr.skipScoring || new Set();

      if (mr.author.username === username) {
        const b = ensure(key);
        b.authored++;
        if (mr.state === "merged") b.merged++;
        if (!skip.has("lines")) {
          b.adds += mr.additions || 0;
          b.dels += mr.deletions || 0;
        }
        if (mr.jira_key) {
          b.priorityPts += SCORE[priorityScoreKey(mr.jira_priority)] || 0;
        }
      }

      if (!skip.has("comments")) {
        for (const c of (mr.commenters || [])) {
          if (c.username === username) ensure(key).comments += c.count;
        }
      }

      if (!skip.has("approvals")) {
        for (const a of (mr.approvers || [])) {
          if (a.username === username) ensure(key).approvals++;
        }
      }
    }

    // Generate all buckets across the full range, filling zeros for empty periods
    const result = [];
    let cur = startKey;
    while (cur <= endKey) {
      const d = bucketData.get(cur) || { authored: 0, merged: 0, comments: 0, approvals: 0, adds: 0, dels: 0, priorityPts: 0 };
      const nonMerged = d.authored - d.merged;
      d.score = Math.round(
        (nonMerged * SCORE.mr_open) + (d.merged * SCORE.mr_merged) +
        (d.comments * SCORE.comment) + (d.approvals * SCORE.approval) +
        (d.adds * SCORE.line_added) + (d.dels * SCORE.line_deleted) + d.priorityPts
      );
      result.push({ key: cur, label: formatBucketLabel(cur, gran), ...d });
      cur = advanceBucket(cur, gran);
    }
    return result;
  }

  function renderDetailCharts(username, period) {
    for (const chart of detailCharts) chart.destroy();
    detailCharts = [];
    detailChartsEl.innerHTML = "";

    const { gran, startKey, endKey } = getDetailRange(period);
    const data = computePerBucketData(username, getFilteredMRs(), gran, startKey, endKey);
    if (data.length === 0) {
      detailChartsEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No activity data</div>';
      return;
    }

    const labels = data.map((d) => d.label);
    const hasPriority = data.some((d) => d.priorityPts > 0);

    const configs = [
      { title: "Score",       values: data.map((d) => d.score),       color: "#6366f1" },
      { title: "MRs Merged",  values: data.map((d) => d.merged),      color: "#10b981" },
      { title: "Comments",    values: data.map((d) => d.comments),     color: "#3b82f6" },
      { title: "Approvals",   values: data.map((d) => d.approvals),    color: "#f59e0b" },
    ];

    if (hasPriority) {
      configs.splice(2, 0, { title: "Bug Priority", values: data.map((d) => d.priorityPts), color: "#ef4444" });
    }

    const colors = getChartColors();

    for (const cfg of configs) {
      if (cfg.values.every((v) => v === 0)) continue;

      const wrap = document.createElement("div");
      wrap.className = "detail-chart-card";
      wrap.innerHTML = `<div class="detail-chart-card-title">${cfg.title}</div><div class="detail-chart-card-wrap"><canvas></canvas></div>`;
      detailChartsEl.appendChild(wrap);

      const canvas = wrap.querySelector("canvas");
      const chart = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [{
            data: cfg.values,
            backgroundColor: cfg.color + "80",
            borderColor: cfg.color,
            borderWidth: 1,
            borderRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(0,0,0,0.8)",
              titleFont: { size: 11 },
              bodyFont: { size: 10 },
              padding: 8,
              cornerRadius: 6,
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: colors.text, font: { size: 9 }, maxRotation: 45, autoSkip: true },
            },
            y: {
              beginAtZero: true,
              grid: { color: colors.grid },
              ticks: { color: colors.text, font: { size: 9 }, precision: 0 },
            },
          },
        },
      });
      detailCharts.push(chart);
    }
  }

  function renderDetailRepos(contributor) {
    const mrs = contributor.authored_mrs;
    const repoMap = new Map();
    for (const mr of mrs) {
      if (!repoMap.has(mr.repoName)) {
        repoMap.set(mr.repoName, { count: 0, merged: 0, adds: 0, dels: 0 });
      }
      const r = repoMap.get(mr.repoName);
      r.count++;
      if (mr.state === "merged") r.merged++;
      r.adds += mr.additions || 0;
      r.dels += mr.deletions || 0;
    }

    const sorted = [...repoMap.entries()].sort((a, b) => b[1].count - a[1].count);

    if (sorted.length === 0) {
      detailRepos.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No repositories</div>';
      return;
    }

    detailRepos.innerHTML =
      `<div class="detail-repo-header">
        <span>Repository</span><span class="detail-repo-num">MRs</span><span class="detail-repo-num">Merged</span><span class="detail-repo-num">Additions</span><span class="detail-repo-num">Deletions</span>
      </div>` +
      sorted.map(([name, s]) =>
        `<div class="detail-repo-row">
          <span class="detail-repo-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="detail-repo-num">${s.count}</span>
          <span class="detail-repo-num">${s.merged}</span>
          <span class="detail-repo-num detail-repo-add">+${s.adds.toLocaleString()}</span>
          <span class="detail-repo-num detail-repo-del">\u2212${s.dels.toLocaleString()}</span>
        </div>`
      ).join("");
  }

  function renderDetailMRs(contributor) {
    const mrs = [...contributor.authored_mrs]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);

    if (mrs.length === 0) {
      detailMRs.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No merge requests</div>';
      return;
    }

    detailMRs.innerHTML = mrs.map((mr) => {
      const dotClass = `detail-mr-dot-${mr.state}`;
      const d = new Date(mr.created_at);
      const dateStr = `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
      const url = mr.web_url ? escapeHtml(mr.web_url) : "#";
      return `<div class="detail-mr-item">
        <span class="detail-mr-dot ${dotClass}"></span>
        <span class="detail-mr-title"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(mr.title)}</a></span>
        <span class="detail-mr-repo">${escapeHtml(mr.repoName)}</span>
        <span class="detail-mr-date">${dateStr}</span>
      </div>`;
    }).join("");
  }

  detailGranToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".gran-btn");
    if (!btn) return;
    detailGranToggle.querySelectorAll(".gran-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    detailGranularity = btn.dataset.gran;
    if (detailCurrentUsername) renderDetailCharts(detailCurrentUsername, detailGranularity);
  });

  detailClose.addEventListener("click", closeContributorDetail);
  detailOverlay.addEventListener("click", (e) => {
    if (e.target === detailOverlay) closeContributorDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !detailOverlay.hidden) closeContributorDetail();
  });

  // --- Helpers ---
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Init ---
  loadScoreConfig().then(loadData);
})();
