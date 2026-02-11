/** GitLab Contributions Tracker — Team Activity Dashboard */

(function () {
  "use strict";

  const SHOW_ALL_TEAMS_KEY = "show-all-teams";
  const AI_THRESHOLD_KEY = "ai-adoption-threshold";
  let showAllTeams = localStorage.getItem(SHOW_ALL_TEAMS_KEY) === "true";

  // Clean up legacy localStorage keys
  localStorage.removeItem("score-config-overrides");
  localStorage.removeItem("badge-config-overrides");

  function getAiAdoptionThreshold() {
    const stored = localStorage.getItem(AI_THRESHOLD_KEY);
    if (stored !== null) {
      const val = parseFloat(stored);
      return isNaN(val) ? 0.3 : val;
    }
    return 0.3;
  }

  // --- State ---
  let allMRs = [];
  let repositories = [];
  let teams = [];
  let generatedAt = "";

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const loadingEl = $("#loading");
  const errorEl = $("#error");
  const appEl = $("#app");
  const leaderboardPeriod = $("#leaderboard-period");
  const filterTeam = $("#filter-team");
  const filterRepo = $("#filter-repo");
  const generatedAtEl = $("#generated-at");
  const themeToggle = $("#theme-toggle");
  const themeIcon = $("#theme-icon");
  const timelineCanvas = $("#timeline-chart");
  const granularityToggle = $("#granularity-toggle");
  let timelineChart = null;
  const detailOverlay = $("#detail-overlay");
  const detailClose = $("#detail-close");
  const detailAvatar = $("#detail-avatar");
  const detailName = $("#detail-name");
  const detailUsername = $("#detail-username");
  const detailMetrics = $("#detail-metrics");
  const detailRepos = $("#detail-repos");
  const detailMRs = $("#detail-mrs");
  const detailCollaborators = $("#detail-collaborators");
  const detailChartsEl = $("#detail-charts");
  const detailGranToggle = $("#detail-gran-toggle");
  const detailPeriodNav = $("#detail-period-nav");
  const detailPeriodPrev = $("#detail-period-prev");
  const detailPeriodNext = $("#detail-period-next");
  const detailPeriodLabel = $("#detail-period-label");
  const customRangePicker = $("#custom-range-picker");
  const customRangeStartInput = $("#custom-range-start");
  const customRangeEndInput = $("#custom-range-end");
  const customRangeApply = $("#custom-range-apply");
  const detailCustomRangePicker = $("#detail-custom-range-picker");
  const detailCustomRangeStartInput = $("#detail-custom-range-start");
  const detailCustomRangeEndInput = $("#detail-custom-range-end");
  const detailCustomRangeApply = $("#detail-custom-range-apply");
  let detailCharts = [];
  let detailGranularity = "month";
  let detailPeriodOffset = 0;
  let detailCurrentUsername = null;
  let currentGranularity = "month";
  let selectedPeriodKey = null;   // null = current period, string = a specific bucket key
  let timelineBucketKeys = [];    // raw keys for each bar index
  let customRangeStart = null;    // "YYYY-MM-DD" or null
  let customRangeEnd = null;
  let detailCustomRangeStart = null;
  let detailCustomRangeEnd = null;

  // Stored period data for drill-down access
  let lastPeriodMRs = [];
  let lastPeriodContributors = [];
  let lastAllFilteredMRs = [];
  let drilldownChart = null;

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

  // --- Data Loading ---
  async function loadData() {
    try {
      const resp = await fetch("data/data.json", { cache: "no-store" });
      if (!resp.ok) throw new Error(`Failed to load data (${resp.status})`);
      const data = await resp.json();

      repositories = data.repositories || [];
      teams = data.teams || [];
      generatedAt = data.generated_at || "";

      allMRs = [];
      for (const repo of repositories) {
        const skip = new Set(repo.skip_scoring || []);
        const repoTeams = repo.teams || [];
        for (const mr of repo.merge_requests) {
          allMRs.push({
            ...mr,
            repoName: repo.name,
            repoPath: repo.full_path,
            repoTeams,
            skipScoring: skip,
          });
        }
      }

      loadingEl.hidden = true;
      appEl.hidden = false;

      populateTeams();
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
    const parts = fullPath.split("/");
    return parts.slice(-2).join("/");
  }

  function populateTeams() {
    const currentTeam = filterTeam.value;
    filterTeam.innerHTML = "";

    if (showAllTeams) {
      const allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = "All Teams";
      filterTeam.appendChild(allOpt);
    }

    for (const team of teams) {
      const opt = document.createElement("option");
      opt.value = team;
      opt.textContent = team;
      filterTeam.appendChild(opt);
    }

    if (currentTeam && teams.includes(currentTeam)) {
      filterTeam.value = currentTeam;
    } else if (!showAllTeams && teams.length > 0) {
      filterTeam.value = teams[0];
    }
  }

  function populateFilters() {
    const selectedTeam = filterTeam.value;

    let filteredRepos = repositories;
    if (selectedTeam) {
      filteredRepos = repositories.filter((r) => {
        const rTeams = r.teams || [];
        return rTeams.includes(selectedTeam);
      });
    }

    const paths = [...new Set(filteredRepos.map((r) => r.full_path))];
    const pathsWithLabels = paths.map(path => ({
      path,
      label: repoDisplayLabel(path)
    })).sort((a, b) => a.label.localeCompare(b.label));

    const currentRepo = filterRepo.value;
    filterRepo.length = 1; // keep "All Repositories"
    for (const { path, label } of pathsWithLabels) {
      const opt = document.createElement("option");
      opt.value = path;
      opt.textContent = label;
      filterRepo.appendChild(opt);
    }
    if (paths.includes(currentRepo)) {
      filterRepo.value = currentRepo;
    }
  }

  function getFilteredMRs() {
    let mrs = allMRs;

    const selectedTeam = filterTeam.value;
    if (selectedTeam) {
      mrs = mrs.filter((mr) => {
        const t = mr.repoTeams || [];
        return t.includes(selectedTeam);
      });
    }

    const repo = filterRepo.value;
    if (repo) {
      mrs = mrs.filter((mr) => mr.repoPath === repo);
    }

    return mrs;
  }

  filterTeam.addEventListener("change", () => {
    filterRepo.value = "";
    populateFilters();
    render();
  });
  filterRepo.addEventListener("change", render);

  // --- Contributor Search ---
  const contributorSearch = $("#contributor-search");
  const searchSuggestions = $("#search-suggestions");
  let allContributors = [];
  let currentSuggestionIndex = -1;

  function updateAllContributors() {
    const mrs = getFilteredMRs();
    allContributors = buildContributors(mrs);
  }

  function searchContributors(query) {
    if (!query || query.length < 2) return [];

    const lowercaseQuery = query.toLowerCase();
    return allContributors.filter(contributor => {
      const name = (contributor.name || '').toLowerCase();
      const username = (contributor.username || '').toLowerCase();
      return name.includes(lowercaseQuery) || username.includes(lowercaseQuery);
    }).slice(0, 8);
  }

  function renderSearchSuggestions(suggestions) {
    if (suggestions.length === 0) {
      searchSuggestions.hidden = true;
      return;
    }

    searchSuggestions.innerHTML = suggestions.map((contributor, index) => {
      const avatarImg = contributor.avatar_url
        ? `<img src="${escapeHtml(contributor.avatar_url)}" class="search-suggestion-avatar" alt="">`
        : `<div class="search-suggestion-avatar" style="background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(contributor.name ? contributor.name.charAt(0).toUpperCase() : contributor.username.charAt(0).toUpperCase())}</div>`;

      return `
        <div class="search-suggestion" data-username="${escapeHtml(contributor.username)}" data-index="${index}">
          ${avatarImg}
          <div class="search-suggestion-info">
            <div class="search-suggestion-name">${escapeHtml(contributor.name || contributor.username)}</div>
            <div class="search-suggestion-username">@${escapeHtml(contributor.username)}</div>
          </div>
        </div>`;
    }).join('');

    searchSuggestions.hidden = false;
    currentSuggestionIndex = -1;
  }

  function selectSuggestion(username) {
    const contributor = allContributors.find(c => c.username === username);
    if (contributor) {
      contributorSearch.value = contributor.name || contributor.username;
      searchSuggestions.hidden = true;
      currentSuggestionIndex = -1;
      openContributorDetail(username);
    }
  }

  function highlightSuggestion(index) {
    const suggestions = searchSuggestions.querySelectorAll('.search-suggestion');
    suggestions.forEach((suggestion, i) => {
      suggestion.classList.toggle('highlighted', i === index);
    });
  }

  contributorSearch.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    if (query.length < 2) {
      searchSuggestions.hidden = true;
      return;
    }

    const suggestions = searchContributors(query);
    renderSearchSuggestions(suggestions);
  });

  contributorSearch.addEventListener("keydown", (e) => {
    const suggestions = searchSuggestions.querySelectorAll('.search-suggestion');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      currentSuggestionIndex = Math.min(currentSuggestionIndex + 1, suggestions.length - 1);
      highlightSuggestion(currentSuggestionIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      currentSuggestionIndex = Math.max(currentSuggestionIndex - 1, -1);
      highlightSuggestion(currentSuggestionIndex);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentSuggestionIndex >= 0) {
        const selectedSuggestion = suggestions[currentSuggestionIndex];
        if (selectedSuggestion) {
          const username = selectedSuggestion.dataset.username;
          selectSuggestion(username);
        }
      }
    } else if (e.key === 'Escape') {
      searchSuggestions.hidden = true;
      currentSuggestionIndex = -1;
      contributorSearch.blur();
    }
  });

  contributorSearch.addEventListener("blur", () => {
    setTimeout(() => {
      searchSuggestions.hidden = true;
      currentSuggestionIndex = -1;
    }, 200);
  });

  searchSuggestions.addEventListener("click", (e) => {
    const suggestion = e.target.closest('.search-suggestion');
    if (suggestion) {
      const username = suggestion.dataset.username;
      selectSuggestion(username);
    }
  });

  function updateSearchData() {
    updateAllContributors();
    if (contributorSearch.value) {
      contributorSearch.value = '';
      searchSuggestions.hidden = true;
    }
  }

  // Granularity toggle
  granularityToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".gran-btn");
    if (!btn) return;
    granularityToggle.querySelectorAll(".gran-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentGranularity = btn.dataset.gran;
    selectedPeriodKey = null;
    if (currentGranularity === "custom") {
      customRangePicker.hidden = false;
      return;
    }
    customRangePicker.hidden = true;
    render();
  });

  customRangeApply.addEventListener("click", () => {
    const start = customRangeStartInput.value;
    const end = customRangeEndInput.value;
    if (!start || !end || start > end) return;
    customRangeStart = start;
    customRangeEnd = end;
    selectedPeriodKey = null;
    render();
  });

  // --- Contributor detail click (delegated on contributor list) ---
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".contributor-row");
    if (!row) return;
    const username = row.dataset.username;
    if (username) openContributorDetail(username);
  });

  // --- Time-period filter ---
  function currentPeriodKey(gran) {
    if (gran === "custom") return "custom";
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
    if (gran === "custom" && periodKey === "custom") {
      if (!customRangeStart || !customRangeEnd) return mrs;
      return mrs.filter((mr) => {
        const d = toKey(utcDate(mr.created_at));
        return d >= customRangeStart && d <= customRangeEnd;
      });
    }
    return mrs.filter((mr) => getBucketKey(mr.created_at, gran) === periodKey);
  }

  function periodBounds(gran, periodKey) {
    if (!periodKey) return null;
    if (gran === "custom" && periodKey === "custom") {
      if (!customRangeStart || !customRangeEnd) return null;
      return { start: customRangeStart, end: customRangeEnd };
    }
    if (gran === "day") {
      return { start: periodKey, end: periodKey };
    }
    if (gran === "week") {
      const mon = new Date(periodKey + "T00:00:00Z");
      const sun = new Date(mon.getTime());
      sun.setUTCDate(sun.getUTCDate() + 6);
      return { start: periodKey, end: toKey(sun) };
    }
    if (gran === "month") {
      const [y, m] = periodKey.split("-").map(Number);
      const first = new Date(Date.UTC(y, m - 1, 1));
      const last = new Date(Date.UTC(y, m, 0));
      return { start: toKey(first), end: toKey(last) };
    }
    return { start: `${periodKey}-01-01`, end: `${periodKey}-12-31` };
  }

  function isDateInBounds(iso, bounds) {
    if (!bounds || !iso) return true;
    const d = toKey(utcDate(iso));
    return d >= bounds.start && d <= bounds.end;
  }

  function formatCustomRangeLabel(startStr, endStr) {
    const s = new Date(startStr + "T00:00:00Z");
    const e = new Date(endStr + "T00:00:00Z");
    const sLabel = `${SHORT_MONTHS[s.getUTCMonth()]} ${s.getUTCDate()}`;
    const eLabel = `${SHORT_MONTHS[e.getUTCMonth()]} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
    return `${sLabel} \u2013 ${eLabel}`;
  }

  function periodLabel(gran, periodKey) {
    if (gran === "custom") {
      if (customRangeStart && customRangeEnd) {
        return formatCustomRangeLabel(customRangeStart, customRangeEnd);
      }
      return "custom range";
    }
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
        comment_dates: [],
        approval_dates: [],
      });
    }
    return map.get(user.username);
  }

  function buildContributors(mrs, bounds) {
    const map = new Map();

    for (const mr of mrs) {
      const skip = mr.skipScoring || new Set();

      if (isDateInBounds(mr.created_at, bounds)) {
        const mrForAuthor = skip.has("lines")
          ? { ...mr, additions: 0, deletions: 0 }
          : mr;
        const author = ensureContributor(map, mr.author);
        author.authored_mrs.push(mrForAuthor);
      }

      if (!skip.has("comments")) {
        for (const c of (mr.commenters || [])) {
          if (!isDateInBounds(c.created_at, bounds)) continue;
          const contributor = ensureContributor(map, c);
          contributor.comments += 1;
          contributor.comment_dates.push(c.created_at);
          if (c.username === mr.author.username) {
            contributor.commentsOnOwn += 1;
          }
        }
      }

      if (!skip.has("approvals")) {
        for (const a of (mr.approvers || [])) {
          if (!isDateInBounds(a.approved_at, bounds)) continue;
          const contributor = ensureContributor(map, a);
          contributor.approvals += 1;
          contributor.approval_dates.push(a.approved_at);
        }
      }
    }

    return [...map.values()];
  }

  // --- Team Aggregate Metrics ---
  function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeTeamAggregates(mrs, contributors) {
    const mergedMRs = mrs.filter((mr) => mr.state === "merged");
    const mrThroughput = mergedMRs.length;

    // Median lead time (days from created to merged)
    const leadTimes = mergedMRs
      .filter((mr) => mr.merged_at)
      .map((mr) => (new Date(mr.merged_at) - new Date(mr.created_at)) / 86400000);
    const medianLeadTime = median(leadTimes);

    // Median first-response turnaround (hours from MR creation to first non-author comment)
    const turnarounds = [];
    for (const mr of mrs) {
      const nonAuthorComments = (mr.commenters || [])
        .filter((c) => c.username !== mr.author.username && c.created_at)
        .map((c) => new Date(c.created_at))
        .sort((a, b) => a - b);
      if (nonAuthorComments.length > 0) {
        const hours = (nonAuthorComments[0] - new Date(mr.created_at)) / 3600000;
        turnarounds.push(hours);
      }
    }
    const medianTurnaround = median(turnarounds);

    // AI rate
    const aiCount = mrs.filter((mr) => mr.ai_coauthored).length;
    const aiRate = mrs.length > 0 ? aiCount / mrs.length : 0;

    // AI breadth
    const threshold = getAiAdoptionThreshold();
    const activeContributorsList = contributors.filter((c) =>
      c.authored_mrs.length > 0 || c.comments > 0 || c.approvals > 0
    );
    const contributorsWithAI = activeContributorsList.filter((c) => {
      if (c.authored_mrs.length === 0) return false;
      const aiMRs = c.authored_mrs.filter((mr) => mr.ai_coauthored).length;
      return (aiMRs / c.authored_mrs.length) >= threshold;
    });
    const aiBreadth = activeContributorsList.length > 0
      ? contributorsWithAI.length / activeContributorsList.length
      : 0;

    // Review coverage
    const mergedWithApproval = mergedMRs.filter((mr) => (mr.approvers || []).length > 0).length;
    const reviewCoverage = mergedMRs.length > 0 ? mergedWithApproval / mergedMRs.length : 0;

    // Active contributors
    const activeContributors = activeContributorsList.length;

    // Lines changed
    const linesChanged = mrs.reduce((s, mr) => s + (mr.additions || 0) + (mr.deletions || 0), 0);

    return {
      mrThroughput,
      medianLeadTime,
      medianTurnaround,
      aiRate,
      aiBreadth,
      reviewCoverage,
      activeContributors,
      linesChanged,
    };
  }

  function computeTrendIndicator(current, previous, invertTrend) {
    if (previous === 0 && current === 0) return { arrow: "\u2014", label: "no change", css: "trend-flat" };
    if (previous === 0) return { arrow: "\u2191", label: "new", css: invertTrend ? "trend-down" : "trend-up" };
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) < 1) return { arrow: "\u2014", label: "~0%", css: "trend-flat" };
    const arrow = pct > 0 ? "\u2191" : "\u2193";
    const label = `${pct > 0 ? "+" : ""}${Math.round(pct)}%`;
    let css;
    if (invertTrend) {
      css = pct > 0 ? "trend-down" : "trend-up";
    } else {
      css = pct > 0 ? "trend-up" : "trend-down";
    }
    return { arrow, label, css };
  }

  function getPreviousPeriodBounds(gran, periodKey) {
    if (!periodKey) return null;
    if (gran === "custom") return null;
    if (gran === "day") {
      const d = new Date(periodKey + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      const prevKey = toKey(d);
      return periodBounds("day", prevKey);
    }
    if (gran === "week") {
      const d = new Date(periodKey + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 7);
      const prevKey = toKey(d);
      return periodBounds("week", prevKey);
    }
    if (gran === "month") {
      const [y, m] = periodKey.split("-").map(Number);
      const prev = new Date(Date.UTC(y, m - 2, 1));
      const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
      return periodBounds("month", prevKey);
    }
    // year
    const prevYear = String(Number(periodKey) - 1);
    return periodBounds("year", prevYear);
  }

  // --- Rendering ---
  function render(skipTimeline) {
    const allFiltered = getFilteredMRs();
    const activePeriod = selectedPeriodKey || currentPeriodKey(currentGranularity);
    const periodMRs = filterMRsToPeriod(allFiltered, currentGranularity, activePeriod);
    const activeBounds = periodBounds(currentGranularity, activePeriod);
    const contributors = buildContributors(allFiltered, activeBounds);

    // Compute current period aggregates
    const aggregates = computeTeamAggregates(periodMRs, contributors);

    // Compute previous period aggregates for trend
    const prevBounds = getPreviousPeriodBounds(currentGranularity, activePeriod);
    let prevAggregates = null;
    if (prevBounds) {
      const prevMRs = allFiltered.filter((mr) => {
        const d = toKey(utcDate(mr.created_at));
        return d >= prevBounds.start && d <= prevBounds.end;
      });
      const prevContributors = buildContributors(allFiltered, prevBounds);
      prevAggregates = computeTeamAggregates(prevMRs, prevContributors);
    }

    leaderboardPeriod.textContent = `Showing activity for ${periodLabel(currentGranularity, activePeriod)} (${periodMRs.length} MRs)`;

    if (generatedAt) {
      generatedAtEl.textContent = `Data from ${new Date(generatedAt).toLocaleString()}`;
    }

    // Store for drill-down access
    lastPeriodMRs = periodMRs;
    lastPeriodContributors = contributors;
    lastAllFilteredMRs = allFiltered;

    renderAggregateCards(aggregates, prevAggregates);
    if (!skipTimeline) renderTimeline(allFiltered);
    renderContributorList(contributors);

    updateSearchData();
  }

  // --- Aggregate Cards ---
  function formatAggregateValue(key, value) {
    if (key === "medianLeadTime") {
      if (value === 0) return "0d";
      if (value < 1) return `${Math.round(value * 24)}h`;
      return `${value.toFixed(1)}d`;
    }
    if (key === "medianTurnaround") {
      if (value === 0) return "0h";
      if (value < 1) return `${Math.round(value * 60)}m`;
      if (value >= 24) return `${(value / 24).toFixed(1)}d`;
      return `${value.toFixed(1)}h`;
    }
    if (key === "aiRate" || key === "aiBreadth" || key === "reviewCoverage") {
      return `${Math.round(value * 100)}%`;
    }
    return value.toLocaleString();
  }

  function renderAggregateCards(aggregates, prevAggregates) {
    const cardsEl = document.getElementById("aggregate-cards");
    if (!cardsEl) return;

    const metrics = [
      { key: "mrThroughput", label: "Merged MRs", invert: false, tip: "Total merge requests that were merged during this period" },
      { key: "medianLeadTime", label: "Median Lead Time", invert: true, tip: "Median time from MR creation to merge \u2014 lower is better" },
      { key: "medianTurnaround", label: "Median Turnaround", invert: true, tip: "Median time from MR creation to first review comment \u2014 lower is better" },
      { key: "aiRate", label: "AI Co-Author Rate", invert: false, tip: "Percentage of MRs co-authored with AI tools (e.g. Copilot, Claude)" },
      { key: "aiBreadth", label: "AI Adoption", invert: false, tip: "Percentage of contributors whose AI co-authored MR rate meets the threshold" },
      { key: "reviewCoverage", label: "Review Coverage", invert: false, tip: "Percentage of merged MRs that received at least one approval" },
      { key: "activeContributors", label: "Active Contributors", invert: false, tip: "Number of people with any activity \u2014 MRs, comments, or reviews" },
      { key: "linesChanged", label: "Lines Changed", invert: false, tip: "Total lines added and deleted across all MRs" },
    ];

    cardsEl.innerHTML = metrics.map((m) => {
      const val = aggregates[m.key];
      const formatted = formatAggregateValue(m.key, val);
      let trendHtml = "";
      if (prevAggregates) {
        const prev = prevAggregates[m.key];
        const trend = computeTrendIndicator(val, prev, m.invert);
        trendHtml = `<div class="aggregate-card-trend ${trend.css}">${trend.arrow} ${trend.label}</div>`;
      }
      return `<div class="aggregate-card" data-metric="${m.key}" data-tooltip="${escapeHtml(m.tip)}">
        <div class="aggregate-card-value">${formatted}</div>
        ${trendHtml}
        <div class="aggregate-card-label">${m.label}</div>
      </div>`;
    }).join("");
  }

  // --- Tooltips for [data-tooltip] elements ---
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "aggregate-tooltip";
  document.body.appendChild(tooltipEl);
  let tooltipTarget = null;

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tooltip]");
    if (!el || el === tooltipTarget) return;
    tooltipTarget = el;
    tooltipEl.textContent = el.dataset.tooltip;
    tooltipEl.classList.add("visible");
    const rect = el.getBoundingClientRect();
    const tipW = tooltipEl.offsetWidth;
    const tipH = tooltipEl.offsetHeight;
    let left = rect.left + rect.width / 2 - tipW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
    let top = rect.top - tipH - 8;
    if (top < 4) top = rect.bottom + 8;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  });

  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-tooltip]");
    if (!el) return;
    if (el.contains(e.relatedTarget)) return;
    tooltipTarget = null;
    tooltipEl.classList.remove("visible");
  });

  // --- Metric Drill-Down Modal ---
  const drilldownOverlay = $("#metric-drilldown-overlay");
  const drilldownTitle = $("#metric-drilldown-title");
  const drilldownBody = $("#metric-drilldown-body");
  const drilldownCloseBtn = $("#metric-drilldown-close");

  document.addEventListener("click", (e) => {
    const card = e.target.closest(".aggregate-card[data-metric]");
    if (!card) return;
    openMetricDrilldown(card.dataset.metric);
  });

  function closeDrilldown() {
    drilldownOverlay.hidden = true;
    document.body.style.overflow = "";
    if (drilldownChart) {
      drilldownChart.destroy();
      drilldownChart = null;
    }
  }

  drilldownCloseBtn.addEventListener("click", closeDrilldown);
  drilldownOverlay.addEventListener("click", (e) => {
    if (e.target === drilldownOverlay) closeDrilldown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drilldownOverlay.hidden) closeDrilldown();
  });

  // Shared drill-down components
  function renderDrilldownRepoTable(rows, columns) {
    if (rows.length === 0) return '<p class="drilldown-summary">No data available</p>';
    const ths = columns.map((c) => `<th${c.align === "right" ? ' style="text-align:right"' : ""}>${escapeHtml(c.label)}</th>`).join("");
    const trs = rows.map((row) => {
      const tds = columns.map((c) => {
        const val = row[c.key];
        const align = c.align === "right" ? ' class="num"' : "";
        return `<td${align}>${typeof val === "number" ? val.toLocaleString() : escapeHtml(String(val))}</td>`;
      }).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<table class="drilldown-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  function renderDrilldownMRList(mrs, columns, limit) {
    if (mrs.length === 0) return '<p class="drilldown-summary">No merge requests found</p>';
    const pageSize = limit || 20;
    let showing = pageSize;

    function buildList(count) {
      const slice = mrs.slice(0, count);
      const items = slice.map((mr) => {
        const url = mr.web_url ? escapeHtml(mr.web_url) : "#";
        const dotClass = `detail-mr-dot-${mr.state}`;
        const metaCols = columns.map((c) => `<span class="drilldown-mr-meta">${typeof c.value === "function" ? c.value(mr) : escapeHtml(String(mr[c.key] || ""))}</span>`).join("");
        return `<div class="drilldown-mr-item">
          <span class="detail-mr-dot ${dotClass}"></span>
          <span class="drilldown-mr-title"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(mr.title)}</a></span>
          ${metaCols}
        </div>`;
      }).join("");
      const moreBtn = count < mrs.length ? `<button class="drilldown-show-more" data-action="show-more">Show more (${mrs.length - count} remaining)</button>` : "";
      return `<div class="drilldown-mr-list">${items}</div>${moreBtn}`;
    }

    const container = document.createElement("div");
    container.innerHTML = buildList(showing);
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='show-more']");
      if (!btn) return;
      showing += pageSize;
      container.innerHTML = buildList(showing);
    });
    return container;
  }

  function renderDrilldownDistribution(values, unit) {
    if (values.length === 0) return '<p class="drilldown-summary">No data available</p>';
    const sorted = [...values].sort((a, b) => a - b);
    const p = (pct) => {
      const idx = Math.floor(pct * sorted.length);
      return sorted[Math.min(idx, sorted.length - 1)];
    };
    const fmt = (v) => {
      if (unit === "days") {
        if (v < 1) return `${Math.round(v * 24)}h`;
        return `${v.toFixed(1)}d`;
      }
      if (unit === "hours") {
        if (v >= 24) return `${(v / 24).toFixed(1)}d`;
        if (v < 1) return `${Math.round(v * 60)}m`;
        return `${v.toFixed(1)}h`;
      }
      return v.toLocaleString();
    };
    const stats = [
      { label: "Min", value: fmt(sorted[0]) },
      { label: "P25", value: fmt(p(0.25)) },
      { label: "Median", value: fmt(p(0.5)) },
      { label: "P75", value: fmt(p(0.75)) },
      { label: "Max", value: fmt(sorted[sorted.length - 1]) },
    ];
    return `<div class="drilldown-distribution">${stats.map((s) => `<div class="drilldown-dist-item"><div class="drilldown-dist-value">${s.value}</div><div class="drilldown-dist-label">${s.label}</div></div>`).join("")}</div>`;
  }

  function renderDrilldownTrendChart(container, dataPoints, labels, color, chartLabel) {
    const wrap = document.createElement("div");
    wrap.className = "drilldown-chart-wrap";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const colors = getChartColors();
    if (drilldownChart) drilldownChart.destroy();
    drilldownChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: chartLabel || "",
          data: dataPoints,
          backgroundColor: color + "80",
          borderColor: color,
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
          x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 9 }, maxRotation: 45, autoSkip: true } },
          y: { beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 9 }, precision: 0 } },
        },
      },
    });
  }

  function getRecentBuckets(mrs, gran, count) {
    const timeline = buildTimelineBuckets(mrs, gran);
    const n = Math.min(count, timeline.keys.length);
    return {
      keys: timeline.keys.slice(-n),
      labels: timeline.labels.slice(-n),
      merged: timeline.merged.slice(-n),
    };
  }

  function groupMRsByRepo(mrs) {
    const repoMap = new Map();
    for (const mr of mrs) {
      const label = repoDisplayLabel(mr.repoPath);
      if (!repoMap.has(label)) repoMap.set(label, []);
      repoMap.get(label).push(mr);
    }
    return repoMap;
  }

  function openMetricDrilldown(metricId) {
    drilldownBody.innerHTML = "";
    if (drilldownChart) {
      drilldownChart.destroy();
      drilldownChart = null;
    }

    const mrs = lastPeriodMRs;
    const contributors = lastPeriodContributors;
    const mergedMRs = mrs.filter((mr) => mr.state === "merged");

    const titles = {
      mrThroughput: "Merged MRs",
      medianLeadTime: "Lead Time to Merge",
      medianTurnaround: "Review Turnaround",
      aiRate: "AI Co-Authorship",
      aiBreadth: "AI Adoption Breadth",
      reviewCoverage: "Review Coverage",
      activeContributors: "Active Contributors",
      linesChanged: "Lines Changed",
    };

    drilldownTitle.textContent = titles[metricId] || metricId;

    if (metricId === "mrThroughput") {
      drilldownMrThroughput(mrs, mergedMRs);
    } else if (metricId === "medianLeadTime") {
      drilldownLeadTime(mergedMRs);
    } else if (metricId === "medianTurnaround") {
      drilldownTurnaround(mrs);
    } else if (metricId === "aiRate") {
      drilldownAiRate(mrs);
    } else if (metricId === "aiBreadth") {
      drilldownAiBreadth(contributors);
    } else if (metricId === "reviewCoverage") {
      drilldownReviewCoverage(mergedMRs);
    } else if (metricId === "activeContributors") {
      drilldownActiveContributors(contributors);
    } else if (metricId === "linesChanged") {
      drilldownLinesChanged(mrs);
    }

    drilldownOverlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function drilldownMrThroughput(mrs, mergedMRs) {
    const repoMap = groupMRsByRepo(mrs);
    const rows = [...repoMap.entries()].map(([repo, repoMRs]) => {
      const merged = repoMRs.filter((mr) => mr.state === "merged").length;
      const total = repoMRs.length;
      return { repo, merged, total, rate: total > 0 ? `${Math.round((merged / total) * 100)}%` : "0%" };
    }).sort((a, b) => b.merged - a.merged);

    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Repo Breakdown</div>` +
      renderDrilldownRepoTable(rows, [
        { key: "repo", label: "Repository" },
        { key: "merged", label: "Merged", align: "right" },
        { key: "total", label: "Total", align: "right" },
        { key: "rate", label: "Merge Rate", align: "right" },
      ]);
    drilldownBody.appendChild(sec1);

    // Trend chart
    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Trend</div>`;
    const recent = getRecentBuckets(lastAllFilteredMRs, currentGranularity === "custom" ? "month" : currentGranularity, 8);
    renderDrilldownTrendChart(sec2, recent.merged, recent.labels, "#10b981", "Merged");
    drilldownBody.appendChild(sec2);

    // MR list
    const sec3 = document.createElement("div");
    sec3.className = "drilldown-section";
    sec3.innerHTML = `<div class="drilldown-section-title">Merged MRs</div>`;
    const sorted = [...mergedMRs].sort((a, b) => new Date(b.merged_at || b.created_at) - new Date(a.merged_at || a.created_at));
    const listEl = renderDrilldownMRList(sorted, [
      { value: (mr) => repoDisplayLabel(mr.repoPath) },
      { value: (mr) => mr.author.name || mr.author.username },
      { value: (mr) => { const d = new Date(mr.merged_at || mr.created_at); return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; } },
    ]);
    sec3.appendChild(listEl);
    drilldownBody.appendChild(sec3);
  }

  function drilldownLeadTime(mergedMRs) {
    const mrsWithLead = mergedMRs.filter((mr) => mr.merged_at).map((mr) => ({
      ...mr,
      _leadDays: (new Date(mr.merged_at) - new Date(mr.created_at)) / 86400000,
    }));

    // Distribution
    const values = mrsWithLead.map((mr) => mr._leadDays);
    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Distribution</div>` + renderDrilldownDistribution(values, "days");
    drilldownBody.appendChild(sec1);

    // Repo breakdown
    const repoMap = groupMRsByRepo(mrsWithLead);
    const rows = [...repoMap.entries()].map(([repo, repoMRs]) => {
      const leads = repoMRs.map((mr) => mr._leadDays);
      const med = median(leads);
      return { repo, median: formatAggregateValue("medianLeadTime", med), count: repoMRs.length };
    }).sort((a, b) => b.count - a.count);

    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Repo Breakdown</div>` +
      renderDrilldownRepoTable(rows, [
        { key: "repo", label: "Repository" },
        { key: "median", label: "Median Lead Time", align: "right" },
        { key: "count", label: "MR Count", align: "right" },
      ]);
    drilldownBody.appendChild(sec2);

    // MR list sorted by lead time desc
    const sorted = [...mrsWithLead].sort((a, b) => b._leadDays - a._leadDays);
    const sec3 = document.createElement("div");
    sec3.className = "drilldown-section";
    sec3.innerHTML = `<div class="drilldown-section-title">MRs by Lead Time</div>`;
    const listEl = renderDrilldownMRList(sorted, [
      { value: (mr) => repoDisplayLabel(mr.repoPath) },
      { value: (mr) => mr.author.name || mr.author.username },
      { value: (mr) => formatAggregateValue("medianLeadTime", mr._leadDays) },
    ]);
    sec3.appendChild(listEl);
    drilldownBody.appendChild(sec3);
  }

  function drilldownTurnaround(mrs) {
    const mrsWithTurnaround = [];
    for (const mr of mrs) {
      const nonAuthorComments = (mr.commenters || [])
        .filter((c) => c.username !== mr.author.username && c.created_at)
        .map((c) => new Date(c.created_at))
        .sort((a, b) => a - b);
      if (nonAuthorComments.length > 0) {
        const hours = (nonAuthorComments[0] - new Date(mr.created_at)) / 3600000;
        mrsWithTurnaround.push({ ...mr, _turnaroundHours: hours });
      }
    }

    // Distribution
    const values = mrsWithTurnaround.map((mr) => mr._turnaroundHours);
    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Distribution</div>` + renderDrilldownDistribution(values, "hours");
    drilldownBody.appendChild(sec1);

    // Repo breakdown
    const repoMap = groupMRsByRepo(mrsWithTurnaround);
    const rows = [...repoMap.entries()].map(([repo, repoMRs]) => {
      const vals = repoMRs.map((mr) => mr._turnaroundHours);
      const med = median(vals);
      return { repo, median: formatAggregateValue("medianTurnaround", med), count: repoMRs.length };
    }).sort((a, b) => b.count - a.count);

    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Repo Breakdown</div>` +
      renderDrilldownRepoTable(rows, [
        { key: "repo", label: "Repository" },
        { key: "median", label: "Median Turnaround", align: "right" },
        { key: "count", label: "MR Count", align: "right" },
      ]);
    drilldownBody.appendChild(sec2);

    // MR list sorted by turnaround desc
    const sorted = [...mrsWithTurnaround].sort((a, b) => b._turnaroundHours - a._turnaroundHours);
    const sec3 = document.createElement("div");
    sec3.className = "drilldown-section";
    sec3.innerHTML = `<div class="drilldown-section-title">MRs by Turnaround</div>`;
    const listEl = renderDrilldownMRList(sorted, [
      { value: (mr) => repoDisplayLabel(mr.repoPath) },
      { value: (mr) => mr.author.name || mr.author.username },
      { value: (mr) => formatAggregateValue("medianTurnaround", mr._turnaroundHours) },
    ]);
    sec3.appendChild(listEl);
    drilldownBody.appendChild(sec3);
  }

  function drilldownAiRate(mrs) {
    const repoMap = groupMRsByRepo(mrs);
    const rows = [...repoMap.entries()].map(([repo, repoMRs]) => {
      const aiMRs = repoMRs.filter((mr) => mr.ai_coauthored).length;
      const total = repoMRs.length;
      return { repo, aiMRs, total, rate: total > 0 ? `${Math.round((aiMRs / total) * 100)}%` : "0%" };
    }).sort((a, b) => b.aiMRs - a.aiMRs);

    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Repo Breakdown</div>` +
      renderDrilldownRepoTable(rows, [
        { key: "repo", label: "Repository" },
        { key: "aiMRs", label: "AI MRs", align: "right" },
        { key: "total", label: "Total MRs", align: "right" },
        { key: "rate", label: "AI Rate", align: "right" },
      ]);
    drilldownBody.appendChild(sec1);

    // Trend chart
    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Trend</div>`;
    const gran = currentGranularity === "custom" ? "month" : currentGranularity;
    const timeline = buildTimelineBuckets(lastAllFilteredMRs, gran);
    const n = Math.min(8, timeline.keys.length);
    const recentKeys = timeline.keys.slice(-n);
    const recentLabels = timeline.labels.slice(-n);

    // Compute AI rate per bucket
    const aiRates = recentKeys.map((key) => {
      const bucketMRs = lastAllFilteredMRs.filter((mr) => getBucketKey(mr.created_at, gran) === key);
      if (bucketMRs.length === 0) return 0;
      return Math.round((bucketMRs.filter((mr) => mr.ai_coauthored).length / bucketMRs.length) * 100);
    });
    renderDrilldownTrendChart(sec2, aiRates, recentLabels, "#a855f7", "AI Rate %");
    drilldownBody.appendChild(sec2);

    // MR list
    const aiMRsList = mrs.filter((mr) => mr.ai_coauthored).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const sec3 = document.createElement("div");
    sec3.className = "drilldown-section";
    sec3.innerHTML = `<div class="drilldown-section-title">AI Co-Authored MRs</div>`;
    const listEl = renderDrilldownMRList(aiMRsList, [
      { value: (mr) => repoDisplayLabel(mr.repoPath) },
      { value: (mr) => mr.author.name || mr.author.username },
      { value: (mr) => { const d = new Date(mr.created_at); return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; } },
    ]);
    sec3.appendChild(listEl);
    drilldownBody.appendChild(sec3);
  }

  function drilldownAiBreadth(contributors) {
    const threshold = getAiAdoptionThreshold();
    const active = contributors.filter((c) => c.authored_mrs.length > 0 || c.comments > 0 || c.approvals > 0);
    const withAuthored = active.filter((c) => c.authored_mrs.length > 0);
    const above = withAuthored.filter((c) => {
      const aiMRs = c.authored_mrs.filter((mr) => mr.ai_coauthored).length;
      return (aiMRs / c.authored_mrs.length) >= threshold;
    });
    const below = withAuthored.length - above.length;
    const noMRs = active.length - withAuthored.length;

    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Summary</div>
      <div class="drilldown-summary">
        <strong>${above.length}</strong> of ${withAuthored.length} contributors with MRs are above the ${Math.round(threshold * 100)}% threshold.<br>
        <strong>${below}</strong> contributors are below the threshold.${noMRs > 0 ? `<br>${noMRs} active contributors have no authored MRs.` : ""}
      </div>
      <div class="drilldown-summary" style="font-size:0.75rem;color:var(--text-muted);">
        Threshold: ${Math.round(threshold * 100)}% (configurable in Settings)
      </div>`;
    drilldownBody.appendChild(sec1);

    // Trend chart
    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Trend</div>`;
    const gran = currentGranularity === "custom" ? "month" : currentGranularity;
    const timeline = buildTimelineBuckets(lastAllFilteredMRs, gran);
    const n = Math.min(8, timeline.keys.length);
    const recentKeys = timeline.keys.slice(-n);
    const recentLabels = timeline.labels.slice(-n);

    const breadthRates = recentKeys.map((key) => {
      const bounds = periodBounds(gran, key);
      if (!bounds) return 0;
      const bucketContributors = buildContributors(lastAllFilteredMRs, bounds);
      const bucketActive = bucketContributors.filter((c) => c.authored_mrs.length > 0);
      if (bucketActive.length === 0) return 0;
      const bucketAbove = bucketActive.filter((c) => {
        const ai = c.authored_mrs.filter((mr) => mr.ai_coauthored).length;
        return (ai / c.authored_mrs.length) >= threshold;
      });
      return Math.round((bucketAbove.length / bucketActive.length) * 100);
    });
    renderDrilldownTrendChart(sec2, breadthRates, recentLabels, "#a855f7", "AI Adoption %");
    drilldownBody.appendChild(sec2);
  }

  function drilldownReviewCoverage(mergedMRs) {
    const repoMap = groupMRsByRepo(mergedMRs);
    const rows = [...repoMap.entries()].map(([repo, repoMRs]) => {
      const reviewed = repoMRs.filter((mr) => (mr.approvers || []).length > 0).length;
      const unreviewed = repoMRs.length - reviewed;
      return { repo, reviewed, unreviewed, rate: repoMRs.length > 0 ? `${Math.round((reviewed / repoMRs.length) * 100)}%` : "0%" };
    }).sort((a, b) => b.unreviewed - a.unreviewed);

    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Repo Breakdown</div>` +
      renderDrilldownRepoTable(rows, [
        { key: "repo", label: "Repository" },
        { key: "reviewed", label: "Reviewed", align: "right" },
        { key: "unreviewed", label: "Unreviewed", align: "right" },
        { key: "rate", label: "Coverage", align: "right" },
      ]);
    drilldownBody.appendChild(sec1);

    // Unreviewed MR list
    const unreviewed = mergedMRs.filter((mr) => (mr.approvers || []).length === 0)
      .sort((a, b) => new Date(b.merged_at || b.created_at) - new Date(a.merged_at || a.created_at));
    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Unreviewed Merged MRs</div>`;
    const listEl = renderDrilldownMRList(unreviewed, [
      { value: (mr) => repoDisplayLabel(mr.repoPath) },
      { value: (mr) => mr.author.name || mr.author.username },
      { value: (mr) => { const d = new Date(mr.merged_at || mr.created_at); return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; } },
    ]);
    sec2.appendChild(listEl);
    drilldownBody.appendChild(sec2);
  }

  function drilldownActiveContributors(contributors) {
    const active = contributors.filter((c) => c.authored_mrs.length > 0 || c.comments > 0 || c.approvals > 0);
    const authored = active.filter((c) => c.authored_mrs.length > 0).length;
    const reviewed = active.filter((c) => c.approvals > 0).length;
    const commented = active.filter((c) => c.comments > 0).length;
    const authoredAndReviewed = active.filter((c) => c.authored_mrs.length > 0 && c.approvals > 0).length;

    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Activity Breakdown</div>` +
      renderDrilldownRepoTable([
        { activity: "Authored MRs", count: authored },
        { activity: "Reviewed (approved)", count: reviewed },
        { activity: "Commented", count: commented },
        { activity: "Both authored & reviewed", count: authoredAndReviewed },
      ], [
        { key: "activity", label: "Activity Type" },
        { key: "count", label: "Contributors", align: "right" },
      ]);
    drilldownBody.appendChild(sec1);

    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Summary</div>
      <div class="drilldown-summary">
        ${active.length} total active contributors in this period.<br>
        ${authoredAndReviewed} contributors both authored and reviewed MRs.
      </div>`;
    drilldownBody.appendChild(sec2);
  }

  function drilldownLinesChanged(mrs) {
    const totalAdds = mrs.reduce((s, mr) => s + (mr.additions || 0), 0);
    const totalDels = mrs.reduce((s, mr) => s + (mr.deletions || 0), 0);
    const total = totalAdds + totalDels;

    // Ratio bar
    const addsPct = total > 0 ? Math.round((totalAdds / total) * 100) : 50;
    const delsPct = 100 - addsPct;
    const sec1 = document.createElement("div");
    sec1.className = "drilldown-section";
    sec1.innerHTML = `<div class="drilldown-section-title">Additions vs Deletions</div>
      <div class="drilldown-ratio-bar">
        <div class="drilldown-ratio-adds" style="width:${addsPct}%">+${totalAdds.toLocaleString()}</div>
        <div class="drilldown-ratio-dels" style="width:${delsPct}%">&minus;${totalDels.toLocaleString()}</div>
      </div>`;
    drilldownBody.appendChild(sec1);

    // Repo breakdown
    const repoMap = groupMRsByRepo(mrs);
    const rows = [...repoMap.entries()].map(([repo, repoMRs]) => {
      const adds = repoMRs.reduce((s, mr) => s + (mr.additions || 0), 0);
      const dels = repoMRs.reduce((s, mr) => s + (mr.deletions || 0), 0);
      return { repo, additions: adds, deletions: dels, total: adds + dels };
    }).sort((a, b) => b.total - a.total);

    const sec2 = document.createElement("div");
    sec2.className = "drilldown-section";
    sec2.innerHTML = `<div class="drilldown-section-title">Repo Breakdown</div>` +
      renderDrilldownRepoTable(rows, [
        { key: "repo", label: "Repository" },
        { key: "additions", label: "Additions", align: "right" },
        { key: "deletions", label: "Deletions", align: "right" },
        { key: "total", label: "Total", align: "right" },
      ]);
    drilldownBody.appendChild(sec2);

    // Top MRs by lines changed
    const sorted = [...mrs].map((mr) => ({ ...mr, _lines: (mr.additions || 0) + (mr.deletions || 0) }))
      .sort((a, b) => b._lines - a._lines);
    const sec3 = document.createElement("div");
    sec3.className = "drilldown-section";
    sec3.innerHTML = `<div class="drilldown-section-title">Top MRs by Lines Changed</div>`;
    const listEl = renderDrilldownMRList(sorted, [
      { value: (mr) => repoDisplayLabel(mr.repoPath) },
      { value: (mr) => mr.author.name || mr.author.username },
      { value: (mr) => `+${(mr.additions || 0).toLocaleString()} / -${(mr.deletions || 0).toLocaleString()}` },
    ]);
    sec3.appendChild(listEl);
    drilldownBody.appendChild(sec3);
  }

  // --- Contributor List ---
  function renderContributorList(contributors) {
    const listBody = document.getElementById("contributor-list-body");
    const toggleBtn = document.getElementById("contributor-list-toggle");
    if (!listBody || !toggleBtn) return;

    const active = contributors.filter((c) =>
      c.authored_mrs.length > 0 || c.comments > 0 || c.approvals > 0
    );
    active.sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

    toggleBtn.innerHTML = `Individual Contributors (${active.length}) <span class="toggle-icon">&#9654;</span>`;

    if (active.length === 0) {
      listBody.innerHTML = `
        <div class="empty-state">
          <p>No contributors found</p>
          <small>Try adjusting the filters</small>
        </div>`;
      return;
    }

    listBody.innerHTML = active.map((c) => {
      const avatarHtml = c.avatar_url
        ? `<img class="lb-avatar" src="${escapeHtml(c.avatar_url)}" alt="" loading="lazy">`
        : `<div class="lb-avatar-placeholder">${escapeHtml((c.name || c.username).charAt(0).toUpperCase())}</div>`;

      const merged = c.authored_mrs.filter((mr) => mr.state === "merged").length;
      const openClosed = c.authored_mrs.filter((mr) => mr.state === "opened" || mr.state === "closed").length;

      const aiMRs = c.authored_mrs.filter((mr) => mr.ai_coauthored).length;

      const badges = [];
      if (merged) badges.push(`<span class="mini-badge mini-badge-merged" data-tooltip="Merge requests that were merged during this period">${merged} merged</span>`);
      if (openClosed) badges.push(`<span class="mini-badge mini-badge-opened" data-tooltip="Merge requests currently open or closed without merging">${openClosed} open/closed</span>`);
      if (c.approvals) badges.push(`<span class="mini-badge mini-badge-merged" data-tooltip="Code reviews (approvals) given on other contributors\u2019 MRs">${c.approvals} reviews</span>`);
      if (c.comments) badges.push(`<span class="mini-badge mini-badge-opened" data-tooltip="Comments left on merge requests (including their own)">${c.comments} comments</span>`);
      if (aiMRs) badges.push(`<span class="mini-badge mini-badge-ai" data-tooltip="Merge requests co-authored with AI tools (e.g. Copilot, Claude)">${aiMRs} AI</span>`);

      return `
        <div class="contributor-row" data-username="${escapeHtml(c.username)}">
          <div class="lb-contributor">
            ${avatarHtml}
            <div class="lb-name-block">
              <span class="lb-name">${escapeHtml(c.name || c.username)}</span>
              <span class="lb-username">@${escapeHtml(c.username)}</span>
            </div>
          </div>
          <div class="contributor-activity">
            ${badges.join("")}
          </div>
        </div>`;
    }).join("");
  }

  // --- Contributor list toggle ---
  document.addEventListener("click", (e) => {
    const toggleBtn = e.target.closest("#contributor-list-toggle");
    if (!toggleBtn) return;
    const listBody = document.getElementById("contributor-list-body");
    if (!listBody) return;
    const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
    toggleBtn.setAttribute("aria-expanded", String(!expanded));
    listBody.hidden = expanded;
  });

  // --- Timeline ---

  function utcDate(iso) {
    const d = new Date(iso);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  function toKey(d) {
    return d.toISOString().slice(0, 10);
  }

  function mondayOf(d) {
    const tmp = new Date(d.getTime());
    const dow = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() - dow + 1);
    return tmp;
  }

  function getBucketKey(iso, gran) {
    const d = utcDate(iso);
    if (gran === "day") return toKey(d);
    if (gran === "week") return toKey(mondayOf(d));
    if (gran === "month") return toKey(d).slice(0, 7);
    return String(d.getUTCFullYear());
  }

  function advanceBucket(key, gran) {
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
      const next = new Date(Date.UTC(y, m, 1));
      return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    }
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
      return `${mLabel} \u2013 ${sLabel}`;
    }
    const d = new Date(key + "T00:00:00Z");
    return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  function buildTimelineBuckets(mrs, gran, filterStart, filterEnd) {
    if (mrs.length === 0) {
      return { keys: [], labels: [], merged: [], opened: [], closed: [] };
    }

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

    const keys = [...buckets.keys()].sort();
    let minKey = keys[0];
    let maxKey = keys[keys.length - 1];

    if (filterStart) {
      minKey = getBucketKey(filterStart + "T00:00:00Z", gran);
    }
    if (filterEnd) {
      maxKey = getBucketKey(filterEnd + "T00:00:00Z", gran);
    }

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

  function pickSubGranularity(startStr, endStr) {
    const s = new Date(startStr + "T00:00:00Z");
    const e = new Date(endStr + "T00:00:00Z");
    const days = Math.round((e - s) / (1000 * 60 * 60 * 24));
    if (days <= 14) return "day";
    if (days <= 90) return "week";
    if (days <= 730) return "month";
    return "year";
  }

  function renderTimeline(mrs) {
    let gran = currentGranularity;
    let filterStart = null;
    let filterEnd = null;

    if (gran === "custom") {
      if (customRangeStart && customRangeEnd) {
        gran = pickSubGranularity(customRangeStart, customRangeEnd);
        filterStart = customRangeStart;
        filterEnd = customRangeEnd;
      } else {
        gran = "month";
      }
    }

    const data = buildTimelineBuckets(mrs, gran, filterStart, filterEnd);
    timelineBucketKeys = data.keys;
    const colors = getChartColors();
    const activePeriod = (currentGranularity === "custom") ? null : (selectedPeriodKey || currentPeriodKey(currentGranularity));

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
          if (!elements.length || currentGranularity === "custom") return;
          const idx = elements[0].index;
          const clickedKey = timelineBucketKeys[idx];
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
      doc.text("Team Activity Report", 14, y);
      y += 8;

      // Metadata line
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      const teamLabel = filterTeam.value || "All Teams";
      const repoLabel = filterRepo.value || "All Repositories";
      const activePeriod = selectedPeriodKey || currentPeriodKey(currentGranularity);
      const period = periodLabel(currentGranularity, activePeriod);
      const genDate = generatedAt ? new Date(generatedAt).toLocaleString() : "N/A";
      doc.text(`Team: ${teamLabel}  |  Repository: ${repoLabel}  |  Period: ${period}  |  Data from: ${genDate}`, 14, y);
      doc.setTextColor(0);
      y += 6;

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

      // Aggregate metrics table
      const allFiltered = getFilteredMRs();
      const periodMRs = filterMRsToPeriod(allFiltered, currentGranularity, activePeriod);
      const activeBounds = periodBounds(currentGranularity, activePeriod);
      const contributors = buildContributors(allFiltered, activeBounds);
      const aggregates = computeTeamAggregates(periodMRs, contributors);

      const metricsData = [
        ["Merged MRs", aggregates.mrThroughput.toLocaleString()],
        ["Median Lead Time", formatAggregateValue("medianLeadTime", aggregates.medianLeadTime)],
        ["Median Turnaround", formatAggregateValue("medianTurnaround", aggregates.medianTurnaround)],
        ["AI Co-Author Rate", formatAggregateValue("aiRate", aggregates.aiRate)],
        ["AI Adoption", formatAggregateValue("aiBreadth", aggregates.aiBreadth)],
        ["Review Coverage", formatAggregateValue("reviewCoverage", aggregates.reviewCoverage)],
        ["Active Contributors", aggregates.activeContributors.toLocaleString()],
        ["Lines Changed", aggregates.linesChanged.toLocaleString()],
      ];

      doc.autoTable({
        startY: y,
        head: [["Metric", "Value"]],
        body: metricsData,
        margin: { left: 14, right: pageW / 2 },
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          1: { halign: "right", fontStyle: "bold" }
        },
        alternateRowStyles: { fillColor: [245, 245, 250] },
      });

      y = doc.lastAutoTable.finalY + 8;

      // Contributor list table
      const active = contributors.filter((c) =>
        c.authored_mrs.length > 0 || c.comments > 0 || c.approvals > 0
      );
      active.sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

      const tableHead = [["Contributor", "Username", "MRs", "Merged", "Reviews", "Comments"]];
      const tableBody = active.map((c) => {
        const merged = c.authored_mrs.filter((mr) => mr.state === "merged").length;
        return [
          c.name || c.username,
          `@${c.username}`,
          c.authored_mrs.length.toString(),
          merged.toString(),
          c.approvals.toString(),
          c.comments.toString(),
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
          2: { halign: "center", cellWidth: 15 },
          3: { halign: "center", cellWidth: 15 },
          4: { halign: "center", cellWidth: 18 },
          5: { halign: "center", cellWidth: 20 },
        },
        alternateRowStyles: { fillColor: [245, 245, 250] },
      });

      // Footer
      const finalY = doc.lastAutoTable.finalY + 8;
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Generated on ${new Date().toLocaleString()} \u2014 GitLab Contributions Tracker`, 14, finalY);

      const filename = `team-activity-${new Date().toISOString().slice(0, 10)}.pdf`;
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

      const allMRsFiltered = getFilteredMRs();
      const periodContributors = buildContributors(allMRsFiltered, getDetailPeriodBounds(detailGranularity, detailPeriodOffset));
      const contributor = periodContributors.find((c) => c.username === detailCurrentUsername);

      const allContributorsList = buildContributors(allMRsFiltered);
      const allTimeContributor = allContributorsList.find((c) => c.username === detailCurrentUsername);
      if (!allTimeContributor) return;

      const periodC = contributor || { username: detailCurrentUsername, name: allTimeContributor.name, authored_mrs: [], comments: 0, commentsOnOwn: 0, approvals: 0 };

      const pdfPeriodLabel = getDetailPeriodLabel(detailGranularity, detailPeriodOffset);

      // Title
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Individual Activity Report", 14, y);
      y += 8;

      // Contributor name and username
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text(`${allTimeContributor.name} (@${allTimeContributor.username})`, 14, y);
      y += 6;

      // Metadata line
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      const repoLabel = filterRepo.value || "All Repositories";
      const genDate = generatedAt ? new Date(generatedAt).toLocaleString() : "N/A";
      doc.text(`Repository: ${repoLabel}  |  Period: ${pdfPeriodLabel}  |  Data from: ${genDate}`, 14, y);
      doc.setTextColor(0);
      y += 6;

      // Separator
      doc.setDrawColor(200);
      doc.line(14, y, pageW - 14, y);
      y += 8;

      // Metrics summary
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("Activity Summary", 14, y);
      y += 6;

      const mergedCount = periodC.authored_mrs.filter((mr) => mr.state === "merged").length;
      const mergedMRsForLead = periodC.authored_mrs.filter((mr) => mr.state === "merged" && mr.merged_at);
      let avgLeadTime = 0;
      if (mergedMRsForLead.length > 0) {
        avgLeadTime = mergedMRsForLead.reduce((s, mr) =>
          s + (new Date(mr.merged_at) - new Date(mr.created_at)) / 86400000, 0) / mergedMRsForLead.length;
      }
      const aiMRCount = periodC.authored_mrs.filter((mr) => mr.ai_coauthored).length;
      const aiPct = periodC.authored_mrs.length > 0 ? Math.round((aiMRCount / periodC.authored_mrs.length) * 100) : 0;

      const activityMetrics = [
        ["Total MRs", periodC.authored_mrs.length.toLocaleString()],
        ["Merged MRs", mergedCount.toLocaleString()],
        ["Comments", periodC.comments.toLocaleString()],
        ["Reviews Given", periodC.approvals.toLocaleString()],
        ["Avg Lead Time", avgLeadTime > 0 ? `${avgLeadTime.toFixed(1)} days` : "N/A"],
        ["AI Co-Authored", `${aiPct}%`],
      ];

      doc.autoTable({
        startY: y,
        head: [["Metric", "Value"]],
        body: activityMetrics,
        margin: { left: 14, right: 14 },
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          1: { halign: "right", fontStyle: "bold" }
        },
        alternateRowStyles: { fillColor: [245, 245, 250] },
      });

      y = doc.lastAutoTable.finalY + 8;

      // Activity charts
      if (detailCharts.length > 0) {
        const chartW = pageW - 28;
        const chartH = 35;
        const chartsPerRow = 2;
        const halfW = (chartW - 4) / 2;

        for (let i = 0; i < detailCharts.length; i++) {
          const chart = detailCharts[i];
          const isLeft = i % chartsPerRow === 0;

          if (isLeft) {
            if (y + chartH + 10 > pageH - 20) {
              doc.addPage();
              y = 15;
            }
            if (i === 0) {
              doc.setFontSize(12);
              doc.setFont("helvetica", "bold");
              doc.text("Activity Charts", 14, y);
              y += 6;
            }
          }

          const titleEl = chart.canvas.closest(".detail-chart-card")?.querySelector(".detail-chart-card-title");
          const title = titleEl ? titleEl.textContent : "";
          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(100);
          const xPos = isLeft ? 14 : 14 + halfW + 4;
          doc.text(title, xPos, y);
          doc.setTextColor(0);

          const chartImg = chart.canvas.toDataURL("image/png", 1.0);
          doc.addImage(chartImg, "PNG", xPos, y + 1, halfW, chartH);

          if (!isLeft || i === detailCharts.length - 1) {
            y += chartH + 8;
          }
        }
      }

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
      for (const mr of periodC.authored_mrs) {
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
      doc.text("Merge Requests", 14, y);
      y += 6;

      const recentMRs = [...periodC.authored_mrs]
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
      doc.text(`Generated on ${new Date().toLocaleString()} \u2014 GitLab Contributions Tracker`, 14, y);

      const filename = `contributor-${allTimeContributor.username}-${new Date().toISOString().slice(0, 10)}.pdf`;
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
  const settingsBtn = $("#btn-settings");
  const settingsOverlay = $("#settings-overlay");
  const settingsBody = $("#settings-body");
  const settingsClose = $("#settings-close");
  const settingsSave = $("#settings-save");
  const settingsReset = $("#settings-reset");

  function openSettings() {
    settingsBody.innerHTML = "";

    // General settings section
    const generalHeader = document.createElement("h3");
    generalHeader.textContent = "General";
    generalHeader.style.cssText = "margin: 0 0 0.75rem; color: var(--accent); font-size: 0.9rem; font-weight: 700;";
    settingsBody.appendChild(generalHeader);

    const allTeamsRow = document.createElement("div");
    allTeamsRow.className = "setting-row";
    allTeamsRow.innerHTML =
      `<label class="setting-label" for="setting-show-all-teams">Show "All Teams" filter</label>` +
      `<input class="setting-checkbox" id="setting-show-all-teams" type="checkbox" ${showAllTeams ? 'checked' : ''}>`;
    settingsBody.appendChild(allTeamsRow);

    // AI Adoption Threshold
    const aiThresholdRow = document.createElement("div");
    aiThresholdRow.className = "setting-row";
    const currentThreshold = getAiAdoptionThreshold();
    aiThresholdRow.innerHTML =
      `<label class="setting-label" for="setting-ai-threshold">AI Adoption Threshold (0\u20131)</label>` +
      `<input class="setting-input" id="setting-ai-threshold" type="number" step="0.05" min="0" max="1" value="${currentThreshold}">`;
    settingsBody.appendChild(aiThresholdRow);

    settingsOverlay.hidden = false;
  }

  function closeSettings() {
    settingsOverlay.hidden = true;
  }

  function saveSettings() {
    const allTeamsCheckbox = settingsBody.querySelector("#setting-show-all-teams");
    showAllTeams = allTeamsCheckbox ? allTeamsCheckbox.checked : false;
    localStorage.setItem(SHOW_ALL_TEAMS_KEY, String(showAllTeams));
    populateTeams();
    populateFilters();

    const aiThresholdInput = settingsBody.querySelector("#setting-ai-threshold");
    if (aiThresholdInput) {
      const val = parseFloat(aiThresholdInput.value);
      if (!isNaN(val) && val >= 0 && val <= 1) {
        localStorage.setItem(AI_THRESHOLD_KEY, String(val));
      }
    }

    closeSettings();
    render();
  }

  function resetSettings() {
    localStorage.removeItem(SHOW_ALL_TEAMS_KEY);
    localStorage.removeItem(AI_THRESHOLD_KEY);
    showAllTeams = false;
    populateTeams();
    populateFilters();
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

  // --- Collaboration Map ---
  function buildCollaborationMap(username, mrs, contributors) {
    const collabMap = new Map();
    const nameToUsername = new Map();
    for (const c of contributors) {
      if (c.name) nameToUsername.set(c.name.toLowerCase(), c.username);
    }

    function ensureCollab(key, name, avatarUrl) {
      if (key === username) return null;
      if (!collabMap.has(key)) {
        collabMap.set(key, {
          username: key,
          name: name || key,
          avatar_url: avatarUrl || "",
          reviews_given: 0,
          reviews_received: 0,
          comments_given: 0,
          comments_received: 0,
          coauthored: 0,
        });
      }
      return collabMap.get(key);
    }

    for (const mr of mrs) {
      const isAuthor = mr.author.username === username;

      if (isAuthor) {
        for (const a of (mr.approvers || [])) {
          const entry = ensureCollab(a.username, a.name, a.avatar_url);
          if (entry) entry.reviews_received++;
        }
      } else {
        for (const a of (mr.approvers || [])) {
          if (a.username === username) {
            const entry = ensureCollab(mr.author.username, mr.author.name, mr.author.avatar_url);
            if (entry) entry.reviews_given++;
          }
        }
      }

      if (isAuthor) {
        for (const c of (mr.commenters || [])) {
          if (c.username === username) continue;
          const entry = ensureCollab(c.username, c.name, c.avatar_url);
          if (entry) entry.comments_received += 1;
        }
      } else {
        for (const c of (mr.commenters || [])) {
          if (c.username === username) {
            const entry = ensureCollab(mr.author.username, mr.author.name, mr.author.avatar_url);
            if (entry) entry.comments_given += 1;
          }
        }
      }

      const coAuthors = mr.co_authors || [];
      if (isAuthor) {
        for (const ca of coAuthors) {
          const matchedUsername = nameToUsername.get(ca.name.toLowerCase());
          if (matchedUsername && matchedUsername !== username) {
            const matched = contributors.find((c) => c.username === matchedUsername);
            const entry = ensureCollab(matchedUsername, matched ? matched.name : ca.name, matched ? matched.avatar_url : "");
            if (entry) entry.coauthored++;
          } else if (!matchedUsername) {
            const key = "coauthor:" + ca.name.toLowerCase();
            const entry = ensureCollab(key, ca.name, "");
            if (entry) entry.coauthored++;
          }
        }
      } else {
        for (const ca of coAuthors) {
          const matchedUsername = nameToUsername.get(ca.name.toLowerCase());
          if (matchedUsername === username) {
            const entry = ensureCollab(mr.author.username, mr.author.name, mr.author.avatar_url);
            if (entry) entry.coauthored++;
          }
        }
      }
    }

    const result = [...collabMap.values()]
      .map((c) => ({
        ...c,
        total: c.reviews_given + c.reviews_received + c.comments_given + c.comments_received + c.coauthored,
      }))
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    return result;
  }

  // --- Detail period filtering ---
  function getDetailPeriodMRs(period, offset = 0) {
    const mrs = getFilteredMRs();
    if (period === "all") return mrs;

    if (period === "custom") {
      if (!detailCustomRangeStart || !detailCustomRangeEnd) return mrs;
      return mrs.filter((mr) => {
        const d = toKey(utcDate(mr.created_at));
        return d >= detailCustomRangeStart && d <= detailCustomRangeEnd;
      });
    }

    const now = new Date();
    const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let startDate, endDate;

    if (period === "week") {
      startDate = mondayOf(nowUTC);
      startDate = new Date(startDate);
      startDate.setUTCDate(startDate.getUTCDate() + (offset * 7));
      endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + 6);
    } else if (period === "month") {
      startDate = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() + offset, 1));
      endDate = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() + offset + 1, 0));
    } else if (period === "year") {
      const targetYear = nowUTC.getUTCFullYear() + offset;
      startDate = new Date(Date.UTC(targetYear, 0, 1));
      endDate = new Date(Date.UTC(targetYear, 11, 31));
    }

    return mrs.filter((mr) => {
      const d = utcDate(mr.created_at);
      return d >= startDate && d <= endDate;
    });
  }

  function getDetailPeriodBounds(period, offset = 0) {
    if (period === "all") return null;
    if (period === "custom") {
      if (!detailCustomRangeStart || !detailCustomRangeEnd) return null;
      return { start: detailCustomRangeStart, end: detailCustomRangeEnd };
    }
    const now = new Date();
    const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let startDate, endDate;
    if (period === "week") {
      startDate = mondayOf(nowUTC);
      startDate = new Date(startDate);
      startDate.setUTCDate(startDate.getUTCDate() + (offset * 7));
      endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + 6);
    } else if (period === "month") {
      startDate = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() + offset, 1));
      endDate = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() + offset + 1, 0));
    } else if (period === "year") {
      const targetYear = nowUTC.getUTCFullYear() + offset;
      startDate = new Date(Date.UTC(targetYear, 0, 1));
      endDate = new Date(Date.UTC(targetYear, 11, 31));
    }
    return { start: toKey(startDate), end: toKey(endDate) };
  }

  function getDetailPeriodLabel(period, offset = 0) {
    if (period === "custom") {
      if (detailCustomRangeStart && detailCustomRangeEnd) {
        return formatCustomRangeLabel(detailCustomRangeStart, detailCustomRangeEnd);
      }
      return "Custom Range";
    }

    const now = new Date();
    const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const FULL_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

    if (period === "week") {
      const currentMonday = mondayOf(nowUTC);
      const targetMonday = new Date(currentMonday);
      targetMonday.setUTCDate(targetMonday.getUTCDate() + (offset * 7));
      const targetSunday = new Date(targetMonday);
      targetSunday.setUTCDate(targetSunday.getUTCDate() + 6);
      const mLabel = `${SHORT_MONTHS[targetMonday.getUTCMonth()]} ${targetMonday.getUTCDate()}`;
      const sLabel = `${SHORT_MONTHS[targetSunday.getUTCMonth()]} ${targetSunday.getUTCDate()}`;
      return `${mLabel} \u2013 ${sLabel}, ${targetMonday.getUTCFullYear()}`;
    }
    if (period === "month") {
      const targetMonth = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() + offset, 1));
      return `${FULL_MONTHS[targetMonth.getUTCMonth()]} ${targetMonth.getUTCFullYear()}`;
    }
    if (period === "year") {
      return String(nowUTC.getUTCFullYear() + offset);
    }
    return "All Time";
  }

  function updateDetailPeriodNav(period, offset) {
    if (period === "all" || period === "custom") {
      detailPeriodNav.hidden = true;
      return;
    }
    detailPeriodNav.hidden = false;
    detailPeriodLabel.textContent = getDetailPeriodLabel(period, offset);
    detailPeriodNext.disabled = (offset >= 0);
    detailPeriodPrev.disabled = false;
  }

  function renderDetailPeriodSections(username, period, offset = 0) {
    const periodMRs = getDetailPeriodMRs(period, offset);
    const allMRsList = getFilteredMRs();
    const periodContributors = buildContributors(allMRsList, getDetailPeriodBounds(period, offset));
    const contributor = periodContributors.find((c) => c.username === username);

    if (contributor) {
      renderDetailMetrics(contributor);
      renderDetailRepos(contributor);
    } else {
      const metricLabels = ["Total MRs", "Merged MRs", "Comments", "Reviews Given", "Avg Lead Time", "AI Co-Authored"];
      detailMetrics.innerHTML = metricLabels.map((label) =>
        `<div class="detail-metric-card">
          <div class="detail-metric-value">0</div>
          <div class="detail-metric-label">${escapeHtml(label)}</div>
        </div>`
      ).join("");
      detailRepos.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No repositories</div>';
    }

    renderDetailCharts(username, period, offset);
    renderDetailCollaborators(
      contributor || { username, name: username, authored_mrs: [], comments: 0, commentsOnOwn: 0, approvals: 0 },
      periodMRs,
      periodContributors
    );

    updateDetailPeriodNav(period, offset);
  }

  // --- Contributor Detail Modal ---
  function openContributorDetail(username) {
    const mrs = getFilteredMRs();
    const contributors = buildContributors(mrs);
    const contributor = contributors.find((c) => c.username === username);
    if (!contributor) return;

    if (contributor.avatar_url) {
      detailAvatar.src = contributor.avatar_url;
      detailAvatar.hidden = false;
    } else {
      detailAvatar.hidden = true;
    }
    detailName.textContent = contributor.name;
    detailUsername.textContent = `@${contributor.username}`;

    detailCurrentUsername = username;
    detailPeriodOffset = 0;
    detailCustomRangePicker.hidden = (detailGranularity !== "custom");

    renderDetailPeriodSections(username, detailGranularity, detailPeriodOffset);

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
    const mergedCount = contributor.authored_mrs.filter((mr) => mr.state === "merged").length;
    const mergedMRs = contributor.authored_mrs.filter((mr) => mr.state === "merged" && mr.merged_at);
    let avgLeadTime = 0;
    if (mergedMRs.length > 0) {
      avgLeadTime = mergedMRs.reduce((s, mr) =>
        s + (new Date(mr.merged_at) - new Date(mr.created_at)) / 86400000, 0) / mergedMRs.length;
    }
    const aiCount = contributor.authored_mrs.filter((mr) => mr.ai_coauthored).length;
    const aiPct = contributor.authored_mrs.length > 0
      ? Math.round((aiCount / contributor.authored_mrs.length) * 100)
      : 0;

    const metrics = [
      { label: "Total MRs", value: contributor.authored_mrs.length.toLocaleString() },
      { label: "Merged MRs", value: mergedCount.toLocaleString() },
      { label: "Comments", value: contributor.comments.toLocaleString() },
      { label: "Reviews Given", value: contributor.approvals.toLocaleString() },
      { label: "Avg Lead Time", value: avgLeadTime > 0 ? `${avgLeadTime.toFixed(1)}d` : "N/A" },
      { label: "AI Co-Authored", value: `${aiPct}%` },
    ];

    detailMetrics.innerHTML = metrics.map((m) =>
      `<div class="detail-metric-card">
        <div class="detail-metric-value">${m.value}</div>
        <div class="detail-metric-label">${escapeHtml(m.label)}</div>
      </div>`
    ).join("");
  }

  function renderDetailCollaborators(contributor, mrs, contributors) {
    const collabs = buildCollaborationMap(contributor.username, mrs, contributors);

    if (collabs.length === 0) {
      detailCollaborators.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No collaborators found</div>';
      return;
    }

    detailCollaborators.innerHTML = collabs.map((c) => {
      const avatarHtml = c.avatar_url
        ? `<img class="detail-collab-avatar" src="${escapeHtml(c.avatar_url)}" alt="" loading="lazy">`
        : `<div class="detail-collab-avatar detail-collab-avatar-placeholder">${escapeHtml(c.name.charAt(0).toUpperCase())}</div>`;
      const badges = [];
      if (c.reviews_given) badges.push(`<span class="mini-badge mini-badge-merged">${c.reviews_given} review${c.reviews_given !== 1 ? "s" : ""} given</span>`);
      if (c.reviews_received) badges.push(`<span class="mini-badge mini-badge-merged">${c.reviews_received} review${c.reviews_received !== 1 ? "s" : ""} received</span>`);
      if (c.comments_given) badges.push(`<span class="mini-badge mini-badge-opened">${c.comments_given} comment${c.comments_given !== 1 ? "s" : ""} given</span>`);
      if (c.comments_received) badges.push(`<span class="mini-badge mini-badge-opened">${c.comments_received} comment${c.comments_received !== 1 ? "s" : ""} received</span>`);
      if (c.coauthored) badges.push(`<span class="mini-badge mini-badge-collab-purple">${c.coauthored} co-authored</span>`);
      const displayUsername = c.username.startsWith("coauthor:") ? "" : `<span class="detail-collab-username">@${escapeHtml(c.username)}</span>`;
      return `<div class="detail-collab-row">
        ${avatarHtml}
        <div class="detail-collab-name">
          <span class="detail-collab-display-name">${escapeHtml(c.name)}</span>
          ${displayUsername}
        </div>
        <div class="detail-collab-badges">${badges.join("")}</div>
        <span class="detail-collab-total">${c.total}</span>
      </div>`;
    }).join("");
  }

  function getDetailRange(period, offset = 0) {
    const now = new Date();
    const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (period === "week") {
      const currentMonday = mondayOf(nowUTC);
      const targetMonday = new Date(currentMonday);
      targetMonday.setUTCDate(targetMonday.getUTCDate() + (offset * 7));
      const targetSunday = new Date(targetMonday);
      targetSunday.setUTCDate(targetSunday.getUTCDate() + 6);
      const end = targetSunday > nowUTC ? nowUTC : targetSunday;
      return { gran: "day", startKey: toKey(targetMonday), endKey: toKey(end) };
    }
    if (period === "month") {
      const targetMonth = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() + offset, 1));
      const firstMonday = mondayOf(targetMonth);
      const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0));
      const lastMonday = mondayOf(lastDay);
      const currentMonday = mondayOf(nowUTC);
      const end = lastMonday > currentMonday ? currentMonday : lastMonday;
      return { gran: "week", startKey: toKey(firstMonday), endKey: toKey(end) };
    }
    if (period === "year") {
      const targetYear = nowUTC.getUTCFullYear() + offset;
      const endMonth = (targetYear === nowUTC.getUTCFullYear())
        ? nowUTC.getUTCMonth() + 1
        : 12;
      return { gran: "month", startKey: `${targetYear}-01`, endKey: `${targetYear}-${String(endMonth).padStart(2, "0")}` };
    }
    if (period === "custom") {
      if (detailCustomRangeStart && detailCustomRangeEnd) {
        const subGran = pickSubGranularity(detailCustomRangeStart, detailCustomRangeEnd);
        const startBucket = getBucketKey(detailCustomRangeStart + "T00:00:00Z", subGran);
        const endBucket = getBucketKey(detailCustomRangeEnd + "T00:00:00Z", subGran);
        return { gran: subGran, startKey: startBucket, endKey: endBucket };
      }
      const ek = `${nowUTC.getUTCFullYear()}-${String(nowUTC.getUTCMonth() + 1).padStart(2, "0")}`;
      return { gran: "month", startKey: ek, endKey: ek };
    }
    if (period === "all") {
      const mrs = getFilteredMRs();
      const endKey = `${nowUTC.getUTCFullYear()}-${String(nowUTC.getUTCMonth() + 1).padStart(2, "0")}`;
      if (mrs.length === 0) {
        return { gran: "month", startKey: endKey, endKey };
      }
      let earliest = null;
      for (const mr of mrs) {
        const d = utcDate(mr.created_at);
        if (!earliest || d < earliest) earliest = d;
      }
      const startKey = `${earliest.getUTCFullYear()}-${String(earliest.getUTCMonth() + 1).padStart(2, "0")}`;
      return { gran: "month", startKey, endKey };
    }
    const endKey = `${nowUTC.getUTCFullYear()}-${String(nowUTC.getUTCMonth() + 1).padStart(2, "0")}`;
    return { gran: "month", startKey: `${nowUTC.getUTCFullYear()}-01`, endKey };
  }

  function computePerBucketData(username, allMRsFiltered, gran, startKey, endKey) {
    const bucketData = new Map();

    function ensure(key) {
      if (!bucketData.has(key)) {
        bucketData.set(key, { authored: 0, merged: 0, comments: 0, approvals: 0, adds: 0, dels: 0, aiCoauthored: 0 });
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
        if (mr.ai_coauthored) b.aiCoauthored++;
      }

      if (!skip.has("comments")) {
        for (const c of (mr.commenters || [])) {
          if (c.username !== username) continue;
          const cKey = c.created_at ? getBucketKey(c.created_at, gran) : key;
          if (cKey < startKey || cKey > endKey) continue;
          ensure(cKey).comments += 1;
        }
      }

      if (!skip.has("approvals")) {
        for (const a of (mr.approvers || [])) {
          if (a.username !== username) continue;
          const aKey = a.approved_at ? getBucketKey(a.approved_at, gran) : key;
          if (aKey < startKey || aKey > endKey) continue;
          ensure(aKey).approvals++;
        }
      }
    }

    const result = [];
    let cur = startKey;
    while (cur <= endKey) {
      const d = bucketData.get(cur) || { authored: 0, merged: 0, comments: 0, approvals: 0, adds: 0, dels: 0, aiCoauthored: 0 };
      result.push({ key: cur, label: formatBucketLabel(cur, gran), ...d });
      cur = advanceBucket(cur, gran);
    }
    return result;
  }

  function renderDetailCharts(username, period, offset = 0) {
    for (const chart of detailCharts) chart.destroy();
    detailCharts = [];
    detailChartsEl.innerHTML = "";

    const { gran, startKey, endKey } = getDetailRange(period, offset);
    const data = computePerBucketData(username, getFilteredMRs(), gran, startKey, endKey);
    if (data.length === 0) {
      detailChartsEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No activity data</div>';
      return;
    }

    const labels = data.map((d) => d.label);

    const configs = [
      { title: "MRs Merged",  values: data.map((d) => d.merged),      color: "#10b981" },
      { title: "Comments",    values: data.map((d) => d.comments),     color: "#3b82f6" },
      { title: "Approvals",   values: data.map((d) => d.approvals),    color: "#f59e0b" },
    ];

    const hasAI = data.some((d) => d.aiCoauthored > 0);
    if (hasAI) {
      configs.push({ title: "AI Co-Authored", values: data.map((d) => d.aiCoauthored), color: "#a855f7" });
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
      const label = repoDisplayLabel(mr.repoPath);
      if (!repoMap.has(label)) {
        repoMap.set(label, { count: 0, merged: 0, adds: 0, dels: 0 });
      }
      const r = repoMap.get(label);
      r.count++;
      if (mr.state === "merged") r.merged++;
      r.adds += mr.additions || 0;
      r.dels += mr.deletions || 0;
    }

    const sorted = [...repoMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

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
      const aiTag = mr.ai_coauthored ? '<span class="detail-mr-ai" title="AI co-authored">\uD83E\uDD16</span>' : "";
      return `<div class="detail-mr-item">
        <span class="detail-mr-dot ${dotClass}"></span>
        <span class="detail-mr-title"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(mr.title)}</a></span>
        ${aiTag}
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
    detailPeriodOffset = 0;
    if (detailGranularity === "custom") {
      detailCustomRangePicker.hidden = false;
      detailPeriodNav.hidden = true;
      return;
    }
    detailCustomRangePicker.hidden = true;
    if (detailCurrentUsername) renderDetailPeriodSections(detailCurrentUsername, detailGranularity, detailPeriodOffset);
  });

  detailCustomRangeApply.addEventListener("click", () => {
    const start = detailCustomRangeStartInput.value;
    const end = detailCustomRangeEndInput.value;
    if (!start || !end || start > end) return;
    detailCustomRangeStart = start;
    detailCustomRangeEnd = end;
    if (detailCurrentUsername) renderDetailPeriodSections(detailCurrentUsername, detailGranularity, detailPeriodOffset);
  });

  detailPeriodPrev.addEventListener("click", () => {
    detailPeriodOffset--;
    if (detailCurrentUsername) renderDetailPeriodSections(detailCurrentUsername, detailGranularity, detailPeriodOffset);
  });

  detailPeriodNext.addEventListener("click", () => {
    if (detailPeriodOffset < 0) {
      detailPeriodOffset++;
      if (detailCurrentUsername) renderDetailPeriodSections(detailCurrentUsername, detailGranularity, detailPeriodOffset);
    }
  });

  detailClose.addEventListener("click", closeContributorDetail);
  detailOverlay.addEventListener("click", (e) => {
    if (e.target === detailOverlay) closeContributorDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !detailOverlay.hidden && drilldownOverlay.hidden) closeContributorDetail();
  });

  // --- Helpers ---
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Init ---
  loadData();
})();
