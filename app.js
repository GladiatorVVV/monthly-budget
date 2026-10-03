/* LEDGER — Monthly Budget Terminal */

const STORAGE_KEY = 'ledger_budget_v1';
const SYNC_CONFIG_KEY = 'ledger_sync_config';
const SCHEMA_VERSION = 1;
const GIST_FILENAME = 'ledger-budget.json';

const CATEGORIES = {
    investments: {
        title: 'INVESTMENTS // SAVINGS',
        type: 'savings',
        items: [
            { id: 'rothIra', name: 'Roth IRA' },
            { id: 'emergencyFund', name: 'Emergency Fund' },
            { id: 'wealthInvesting', name: 'Wealth Investing' },
            { id: 'strategicInvesting', name: 'Strategic Investing' },
            { id: 'robinhood', name: 'Robinhood' },
            { id: 'coinbase', name: 'Coinbase' },
        ],
    },
    creditCards: {
        title: 'CREDIT CARDS',
        type: 'expense',
        items: [
            { id: 'robinhoodGold', name: 'Robinhood Gold' },
            { id: 'amexGold', name: 'AMEX Gold' },
            { id: 'primeVisa', name: 'Prime Visa' },
            { id: 'freedomUnlimited', name: 'Freedom Unlimited' },
            { id: 'costcoCiti', name: 'Costco Citi' },
            { id: 'ventureX', name: 'Venture X' },
        ],
    },
    otherExpenses: {
        title: 'UTILITIES // RECURRING',
        type: 'expense',
        items: [
            { id: 'metronet', name: 'Metronet' },
            { id: 'tmobile', name: 'T-Mobile' },
        ],
    },
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// ---- Data store ----
let state = {
    version: SCHEMA_VERSION,
    activeMonth: null,
    yearlyTargets: {},
    months: {},
};

// ---- Sync state ----
let syncConfig = null; // { pat, gistId }
let syncDebounceTimer = null;
let syncInFlight = false;

// ---- View state ----
let reviewYear = null; // year whose annual report is shown, or null for the monthly view

// ---- Helpers ----
function emptyMonth() {
    const data = {};
    Object.entries(CATEGORIES).forEach(([key, cat]) => {
        data[key] = {};
        cat.items.forEach(item => {
            data[key][item.id] = { projected: 0, actual: 0 };
        });
    });
    data.notes = '';
    return data;
}

function monthKey(year, monthIdx) {
    return `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
}

function parseMonthKey(key) {
    const [y, m] = key.split('-').map(Number);
    return { year: y, monthIdx: m - 1 };
}

function formatMonthLabel(key) {
    const { year, monthIdx } = parseMonthKey(key);
    return `${MONTH_NAMES[monthIdx].toUpperCase()} ${year}`;
}

function fmtUSD(n) {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSignedUSD(n) {
    return (n > 0 ? '+' : '') + fmtUSD(n);
}

function fmtCompact(n) {
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return `${sign}$${Math.round(a)}`;
}

function fmtPct(n, digits = 1) {
    return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTimestamp(iso) {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return `${date} · ${time}`;
}

function fmtRelative(iso) {
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 45) return 'JUST NOW';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} MIN AGO`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} HR AGO`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days} DAY${days === 1 ? '' : 'S'} AGO`;
    return '';
}

// ---- Persistence (localStorage) ----
function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setSaveStatus('LOCAL STATE SYNCED');
}

function loadLocal() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
        state = migrate(JSON.parse(raw));
        return true;
    } catch (e) {
        return false;
    }
}

function migrate(data) {
    if (!data.version) data.version = SCHEMA_VERSION;
    if (!data.months) data.months = {};
    if (!data.yearlyTargets) data.yearlyTargets = {};
    Object.keys(data.months).forEach(mk => {
        const existing = data.months[mk];
        const fresh = emptyMonth();
        Object.keys(fresh).forEach(catKey => {
            if (catKey === 'notes') {
                if (typeof existing.notes !== 'string') existing.notes = '';
                return;
            }
            if (!existing[catKey]) existing[catKey] = {};
            Object.keys(fresh[catKey]).forEach(itemId => {
                if (!existing[catKey][itemId]) {
                    existing[catKey][itemId] = { projected: 0, actual: 0 };
                }
            });
        });
    });
    return data;
}

// ---- Sync config ----
function loadSyncConfig() {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function saveSyncConfig(config) {
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
    syncConfig = config;
}

function clearSyncConfig() {
    localStorage.removeItem(SYNC_CONFIG_KEY);
    syncConfig = null;
}

// ---- GitHub Gist API ----
async function gistRequest(method, path, body, pat) {
    const token = pat || syncConfig?.pat;
    const resp = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${resp.status}`);
    }
    return resp.json();
}

async function findOrCreateGist(pat) {
    // Search first page of user's gists for existing ledger file
    const gists = await gistRequest('GET', '/gists?per_page=100', null, pat);
    const existing = gists.find(g => g.files[GIST_FILENAME]);
    if (existing) return existing.id;

    // Create a new secret gist
    const created = await gistRequest('POST', '/gists', {
        description: 'LEDGER // Monthly Budget Data',
        public: false,
        files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
    }, pat);
    return created.id;
}

async function loadFromGist() {
    if (!syncConfig) return;
    setSyncStatusLabel('SYNCING...', 'syncing');
    try {
        const gist = await gistRequest('GET', `/gists/${syncConfig.gistId}`);
        const raw = gist.files[GIST_FILENAME]?.content;
        if (raw) {
            const parsed = JSON.parse(raw);
            state = migrate(parsed);
            // Data saved before timestamps existed: fall back to the gist's own edit time
            if (!state.lastUpdated && gist.updated_at) state.lastUpdated = gist.updated_at;
            saveLocal();
            renderAll();
        }
        setSyncStatusLabel('CLOUD SYNCED', 'synced');
    } catch (e) {
        setSyncStatusLabel('SYNC ERROR', 'error');
        console.error('Gist load failed:', e);
    }
}

async function saveToGist() {
    if (!syncConfig || syncInFlight) return;
    syncInFlight = true;
    setSyncStatusLabel('SAVING...', 'syncing');
    try {
        await gistRequest('PATCH', `/gists/${syncConfig.gistId}`, {
            files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
        });
        setSyncStatusLabel('CLOUD SYNCED', 'synced');
    } catch (e) {
        setSyncStatusLabel('SYNC ERROR', 'error');
        console.error('Gist save failed:', e);
    } finally {
        syncInFlight = false;
    }
}

function scheduleSyncSave() {
    if (!syncConfig) return;
    clearTimeout(syncDebounceTimer);
    setSyncStatusLabel('UNSAVED CHANGES', 'pending');
    syncDebounceTimer = setTimeout(saveToGist, 1500);
}

// ---- Sync UI ----
function setSyncStatusLabel(text, state) {
    const el = document.getElementById('syncStatus');
    const icon = document.getElementById('syncIcon');
    const label = document.getElementById('syncLabel');
    if (el) { el.textContent = text; el.className = `sync-state-${state}`; }
    if (icon) {
        icon.className = 'sync-icon';
        if (state === 'syncing') icon.classList.add('spinning');
    }
    if (label && syncConfig) label.textContent = text;
}

function renderSyncBtn() {
    const icon = document.getElementById('syncIcon');
    const label = document.getElementById('syncLabel');
    const btn = document.getElementById('syncBtn');
    if (!syncConfig) {
        icon.textContent = '☁';
        icon.className = 'sync-icon';
        label.textContent = 'CONNECT SYNC';
        btn.classList.remove('btn-sync-connected');
    } else {
        icon.textContent = '⬡';
        label.textContent = 'CLOUD SYNCED';
        btn.classList.add('btn-sync-connected');
    }
}

// ---- Sync setup modal ----
function openSyncModal() {
    try {
    const overlay = document.getElementById('syncOverlay');
    const content = document.getElementById('syncModalContent');
    if (!overlay || !content) { showToast('ERROR: MODAL ELEMENTS MISSING'); return; }

    const closeModal = () => { overlay.style.display = 'none'; };

    // Close on backdrop click
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

    if (syncConfig) {
        content.innerHTML = `
            <h3>CLOUD SYNC // CONNECTED</h3>
            <p class="modal-info">Your data is automatically saved to a private GitHub Gist and syncs across all your devices.</p>
            <div class="modal-gist-id">
                <span class="mono-label">GIST ID</span>
                <span class="mono-val">${syncConfig.gistId}</span>
            </div>
            <p class="modal-hint">To connect another device, open this site there and paste the same GitHub token.</p>
            <div class="modal-actions">
                <button class="btn btn-ghost" id="modalDisconnectBtn">DISCONNECT</button>
                <button class="btn btn-accent" id="modalCloseBtn">CLOSE</button>
            </div>
        `;
        content.querySelector('#modalCloseBtn').addEventListener('click', closeModal);
        content.querySelector('#modalDisconnectBtn').addEventListener('click', () => {
            clearSyncConfig();
            renderSyncBtn();
            setSyncStatusLabel('CLOUD SYNC OFFLINE', 'offline');
            closeModal();
            showToast('SYNC DISCONNECTED // DATA STAYS LOCAL');
        });
    } else {
        content.innerHTML = `
            <h3>CONNECT CLOUD SYNC</h3>
            <p class="modal-info">Your budget will auto-save to a private GitHub Gist — invisible to anyone without your token. One-time setup per device.</p>
            <ol class="setup-steps">
                <li>Go to <strong>github.com → Settings → Developer Settings → Personal access tokens → Tokens (classic)</strong></li>
                <li>Click <strong>Generate new token (classic)</strong></li>
                <li>Give it any name (e.g. <em>ledger-sync</em>), check only the <strong>gist</strong> scope, click <strong>Generate token</strong></li>
                <li>Copy the token and paste it below</li>
            </ol>
            <div class="modal-field">
                <label class="mono-label">GITHUB TOKEN</label>
                <input type="password" id="patInput" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false">
            </div>
            <div id="syncError" class="sync-error" style="display:none"></div>
            <div class="modal-actions">
                <button class="btn btn-ghost" id="modalCancelBtn">CANCEL</button>
                <button class="btn btn-accent" id="modalConnectBtn">CONNECT</button>
            </div>
        `;
        content.querySelector('#modalCancelBtn').addEventListener('click', closeModal);
        const connectBtn = content.querySelector('#modalConnectBtn');
        const patInput = content.querySelector('#patInput');
        const errEl = content.querySelector('#syncError');

        connectBtn.addEventListener('click', async () => {
            const pat = patInput.value.trim();
            if (!pat) { showSyncError(errEl, 'Please enter your GitHub token.'); return; }
            connectBtn.textContent = 'CONNECTING...';
            connectBtn.disabled = true;
            errEl.style.display = 'none';
            try {
                const gistId = await findOrCreateGist(pat);
                saveSyncConfig({ pat, gistId });
                renderSyncBtn();
                closeModal();
                showToast('SYNC CONNECTED // LOADING YOUR DATA');
                await loadFromGist();
            } catch (e) {
                connectBtn.textContent = 'CONNECT';
                connectBtn.disabled = false;
                showSyncError(errEl, `Connection failed: ${e.message}`);
            }
        });

        patInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') connectBtn.click();
        });
    }

    overlay.style.display = 'flex';
    } catch(err) { showToast('SYNC ERROR: ' + err.message); console.error(err); }
}

function showSyncError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
}

// ---- Month / data helpers ----
function ensureMonth(key) {
    if (!state.months[key]) state.months[key] = emptyMonth();
}

function getActiveMonth() {
    if (!state.activeMonth) state.activeMonth = monthKey(2026, 3);
    ensureMonth(state.activeMonth);
    return state.months[state.activeMonth];
}

function sortedMonthKeys() {
    return Object.keys(state.months).sort();
}

// Navigation order: every month, with a year-in-review stop right after each December
function navEntries() {
    const entries = [];
    sortedMonthKeys().forEach(k => {
        entries.push({ type: 'month', key: k });
        const { year, monthIdx } = parseMonthKey(k);
        if (monthIdx === 11) entries.push({ type: 'review', year, key: `review:${year}` });
    });
    return entries;
}

function hasReview(year) {
    return !!state.months[monthKey(year, 11)];
}

function openMonth(key) {
    ensureMonth(key);
    reviewYear = null;
    state.activeMonth = key;
}

function openReview(year) {
    reviewYear = year;
    state.activeMonth = monthKey(year, 11);
}

// ---- Save (local + cloud) ----
function save() {
    saveLocal();
    scheduleSyncSave();
}

// Save a change to budget data (not just navigation) and stamp it as the last update
function commit() {
    state.lastUpdated = new Date().toISOString();
    save();
    renderLastUpdated();
}

// ---- Calculations ----
function sumProjected(catKey) {
    return Object.values(getActiveMonth()[catKey]).reduce((s, v) => s + (Number(v.projected) || 0), 0);
}
function sumActual(catKey) {
    return Object.values(getActiveMonth()[catKey]).reduce((s, v) => s + (Number(v.actual) || 0), 0);
}
function projectedSavings()  { return sumProjected('investments'); }
function actualSavings()     { return sumActual('investments'); }
function projectedExpenses() { return sumProjected('creditCards') + sumProjected('otherExpenses'); }
function actualExpenses()    { return sumActual('creditCards') + sumActual('otherExpenses'); }

// ---- IRA ----
function getIraYear() {
    return Number(document.getElementById('yearSelect').value) || parseMonthKey(state.activeMonth).year;
}
function getIraTarget(year) {
    return Number(state.yearlyTargets[year]) || 7500;
}
function iraMonthContribution(year, monthIdx) {
    const m = state.months[monthKey(year, monthIdx)];
    return m ? (Number(m.investments?.rothIra?.actual) || 0) : 0;
}
function iraYearTotal(year) {
    let t = 0;
    for (let i = 0; i < 12; i++) t += iraMonthContribution(year, i);
    return t;
}

// ---- Rendering ----
function renderCategory(catKey) {
    const cat = CATEGORIES[catKey];
    const grid = document.getElementById(`${catKey}Grid`);
    const data = getActiveMonth()[catKey];
    grid.innerHTML = '';

    cat.items.forEach(item => {
        const v = data[item.id];
        const diff = (Number(v.actual) || 0) - (Number(v.projected) || 0);
        const hasActual = Number(v.actual) > 0;
        let diffClass = 'diff-neutral', diffLabel = 'AWAITING ACTUAL';
        if (hasActual) {
            if (cat.type === 'savings') {
                if (diff > 0)      { diffClass = 'diff-under'; diffLabel = `+${fmtUSD(Math.abs(diff))} ABOVE`; }
                else if (diff < 0) { diffClass = 'diff-over';  diffLabel = `${fmtUSD(Math.abs(diff))} BELOW`; }
                else               { diffLabel = 'ON TARGET'; }
            } else {
                if (diff < 0)      { diffClass = 'diff-under'; diffLabel = `${fmtUSD(Math.abs(diff))} UNDER`; }
                else if (diff > 0) { diffClass = 'diff-over';  diffLabel = `+${fmtUSD(Math.abs(diff))} OVER`; }
                else               { diffLabel = 'ON TARGET'; }
            }
        }

        const el = document.createElement('div');
        el.className = 'cat-item' + (hasActual && diff !== 0 ? ' has-diff' : '');
        el.innerHTML = `
            <div class="cat-name">${item.name}</div>
            <div class="cat-inputs">
                <div class="cat-field">
                    <label>PROJECTED</label>
                    <div class="amount-input-wrap">
                        <input type="number" class="amount-input" data-cat="${catKey}" data-item="${item.id}" data-kind="projected" value="${v.projected || ''}" placeholder="0.00" step="0.01" inputmode="decimal">
                    </div>
                </div>
                <div class="cat-field">
                    <label>ACTUAL</label>
                    <div class="amount-input-wrap">
                        <input type="number" class="amount-input is-actual" data-cat="${catKey}" data-item="${item.id}" data-kind="actual" value="${v.actual || ''}" placeholder="0.00" step="0.01" inputmode="decimal">
                    </div>
                </div>
            </div>
            <div class="cat-diff ${diffClass}"><span>${diffLabel}</span></div>
        `;
        grid.appendChild(el);
    });

    updateCategoryTotals(catKey);
}

function renderSummary() {
    const pS = projectedSavings(), aS = actualSavings();
    const pE = projectedExpenses(), aE = actualExpenses();

    document.getElementById('projSavings').textContent = fmtUSD(pS);
    document.getElementById('actSavings').textContent  = fmtUSD(aS);
    document.getElementById('projExpenses').textContent = fmtUSD(pE);
    document.getElementById('actExpenses').textContent  = fmtUSD(aE);

    const net = aS - aE;
    const netEl = document.getElementById('overallNet');
    netEl.textContent = fmtUSD(net);
    netEl.classList.toggle('negative', net < 0);
    netEl.classList.toggle('positive', net > 0);

    const statusEl = document.getElementById('overallStatus');
    statusEl.className = 'kpi-status';
    if (aE === 0 && aS === 0) {
        statusEl.textContent = '— AWAITING DATA';
    } else if (aE > pE && pE > 0) {
        statusEl.classList.add('over');
        statusEl.textContent = `▲ OVER BUDGET BY ${fmtUSD(aE - pE)}`;
    } else if (pE > 0 && aE < pE) {
        statusEl.classList.add('under');
        statusEl.textContent = `▼ UNDER BUDGET BY ${fmtUSD(pE - aE)}`;
    } else {
        statusEl.classList.add('on');
        statusEl.textContent = '◆ ON BUDGET';
    }
}

function renderIraPanel() {
    const year = getIraYear();
    const target = getIraTarget(year);
    const contributed = iraYearTotal(year);
    const remaining = Math.max(0, target - contributed);
    const pct = target > 0 ? Math.min(100, (contributed / target) * 100) : 0;

    document.getElementById('iraContributed').textContent = fmtUSD(contributed);
    document.getElementById('iraRemaining').textContent   = fmtUSD(remaining);
    document.getElementById('iraTarget').value = target;
    document.getElementById('iraPercent').textContent = `${pct.toFixed(1)}%`;
    document.getElementById('iraProgressFill').style.width = `${pct}%`;

    const grid = document.getElementById('iraMonths');
    grid.innerHTML = '';
    const { year: activeYear, monthIdx: activeIdx } = parseMonthKey(state.activeMonth);

    for (let i = 0; i < 12; i++) {
        const amount = iraMonthContribution(year, i);
        const cell = document.createElement('div');
        const cls = ['ira-month-cell', amount > 0 ? 'funded' : 'empty'];
        if (i === activeIdx && year === activeYear) cls.push('active');
        cell.className = cls.join(' ');
        cell.innerHTML = `
            <div class="ira-month-name">${MONTH_SHORT[i]}</div>
            <div class="ira-month-amount">${amount > 0 ? fmtUSD(amount) : '—'}</div>
        `;
        cell.addEventListener('click', () => {
            openMonth(monthKey(year, i));
            save();
            renderAll();
        });
        grid.appendChild(cell);
    }
}

function renderMonthSelect() {
    const sel = document.getElementById('monthSelect');
    sel.innerHTML = '';
    const keys = sortedMonthKeys();
    if (!keys.length) {
        ensureMonth(state.activeMonth);
        return renderMonthSelect();
    }
    const current = reviewYear !== null ? `review:${reviewYear}` : state.activeMonth;
    navEntries().forEach(entry => {
        const opt = document.createElement('option');
        opt.value = entry.key;
        opt.textContent = entry.type === 'review'
            ? `★ ${entry.year} // REVIEW`
            : formatMonthLabel(entry.key);
        if (entry.key === current) opt.selected = true;
        sel.appendChild(opt);
    });
}

function renderYearSelect() {
    const sel = document.getElementById('yearSelect');
    const years = new Set(Object.keys(state.months).map(k => parseMonthKey(k).year));
    years.add(parseMonthKey(state.activeMonth).year);
    const prev = Number(sel.value);
    sel.innerHTML = '';
    [...years].sort().forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        sel.appendChild(opt);
    });
    sel.value = (prev && years.has(prev)) ? prev : parseMonthKey(state.activeMonth).year;
}

function renderVersionTag() {
    const { year, monthIdx } = parseMonthKey(state.activeMonth);
    document.getElementById('versionTag').textContent =
        reviewYear !== null ? `v${reviewYear}.YR` : `v${year}.${monthIdx + 1}`;
}

function renderLastUpdated() {
    const wrap = document.getElementById('lastUpdated');
    const valueEl = document.getElementById('lastUpdatedValue');
    const agoEl = document.getElementById('lastUpdatedAgo');
    const iso = state.lastUpdated;
    if (!iso || Number.isNaN(new Date(iso).getTime())) {
        valueEl.textContent = 'NO EDITS LOGGED YET';
        agoEl.textContent = '';
        wrap.classList.add('is-empty');
        wrap.removeAttribute('title');
        return;
    }
    wrap.classList.remove('is-empty');
    valueEl.textContent = fmtTimestamp(iso);
    const ago = fmtRelative(iso);
    agoEl.textContent = ago ? `(${ago})` : '';
    wrap.title = new Date(iso).toString();
}

function renderNotes() {
    document.getElementById('notesField').value = getActiveMonth().notes || '';
}

function renderAll() {
    if (reviewYear !== null && !hasReview(reviewYear)) reviewYear = null;
    const inReview = reviewYear !== null;
    document.getElementById('monthView').hidden = inReview;
    document.getElementById('reviewView').hidden = !inReview;
    document.getElementById('monthLabel').textContent = inReview ? 'ANNUAL REPORT' : 'ACTIVE CYCLE';

    renderMonthSelect();
    renderVersionTag();
    renderLastUpdated();
    if (inReview) {
        renderReview(reviewYear);
        return;
    }
    renderYearSelect();
    renderSummary();
    renderIraPanel();
    Object.keys(CATEGORIES).forEach(renderCategory);
    renderNotes();
}

// ---- Annual report: analytics ----
function monthSums(m) {
    const r = { cats: {}, items: {}, pS: 0, aS: 0, pE: 0, aE: 0 };
    Object.entries(CATEGORIES).forEach(([catKey, cat]) => {
        let p = 0, a = 0;
        cat.items.forEach(item => {
            const v = m?.[catKey]?.[item.id];
            const ip = Number(v?.projected) || 0, ia = Number(v?.actual) || 0;
            r.items[item.id] = { p: ip, a: ia };
            p += ip; a += ia;
        });
        r.cats[catKey] = { p, a };
        if (cat.type === 'savings') { r.pS += p; r.aS += a; }
        else                        { r.pE += p; r.aE += a; }
    });
    r.net = r.aS - r.aE;
    r.tracked = r.aS > 0 || r.aE > 0;
    r.budgetEvaluated = r.pE > 0 && r.aE > 0;
    r.underBudget = r.budgetEvaluated && r.aE <= r.pE;
    r.savingsEvaluated = r.pS > 0 && r.tracked;
    r.savingsHit = r.savingsEvaluated && r.aS >= r.pS;
    return r;
}

function stats(values) {
    const n = values.length;
    if (!n) return { n: 0, mean: 0, sd: 0, cv: NaN, median: 0, min: 0, max: 0 };
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    const sorted = [...values].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    return { n, mean, sd, cv: mean ? (sd / mean) * 100 : NaN, median, min: sorted[0], max: sorted[n - 1] };
}

function pickBy(list, score) {
    return list.reduce((best, x) => (best === null || score(x) > score(best) ? x : best), null);
}

function computeYear(year) {
    const months = [];
    for (let i = 0; i < 12; i++) {
        const m = state.months[monthKey(year, i)];
        months.push({ ...monthSums(m), idx: i, exists: !!m });
    }
    const tracked = months.filter(m => m.tracked);
    const total = (field) => months.reduce((s, m) => s + m[field], 0);
    const t = { pS: total('pS'), aS: total('aS'), pE: total('pE'), aE: total('aE') };
    t.net = t.aS - t.aE;

    const cats = {};
    Object.entries(CATEGORIES).forEach(([catKey, cat]) => {
        const p = months.reduce((s, m) => s + m.cats[catKey].p, 0);
        const a = months.reduce((s, m) => s + m.cats[catKey].a, 0);
        cats[catKey] = { p, a, variance: a - p, type: cat.type, title: cat.title };
    });

    const items = [];
    Object.entries(CATEGORIES).forEach(([catKey, cat]) => {
        cat.items.forEach(item => {
            const series = months.map(m => m.items[item.id].a);
            const projSeries = months.map(m => m.items[item.id].p);
            const p = projSeries.reduce((s, v) => s + v, 0);
            const a = series.reduce((s, v) => s + v, 0);
            const active = series.filter(v => v > 0);
            const st = stats(active);
            const peakIdx = a > 0 ? series.indexOf(Math.max(...series)) : -1;
            const catTotal = cats[catKey].a;
            const typeTotal = cat.type === 'savings' ? t.aS : t.aE;
            items.push({
                id: item.id, name: item.name, catKey, type: cat.type,
                series, p, a, variance: a - p,
                variancePct: p > 0 ? ((a - p) / p) * 100 : NaN,
                activeMonths: active.length,
                avg: st.mean, median: st.median, cv: st.cv,
                peakIdx, peak: peakIdx >= 0 ? series[peakIdx] : 0,
                catShare: catTotal > 0 ? (a / catTotal) * 100 : 0,
                typeShare: typeTotal > 0 ? (a / typeTotal) * 100 : 0,
            });
        });
    });

    const quarters = [0, 1, 2, 3].map(q => {
        const qs = months.slice(q * 3, q * 3 + 3);
        const sum = (f) => qs.reduce((s, m) => s + m[f], 0);
        const r = { q: q + 1, pS: sum('pS'), aS: sum('aS'), pE: sum('pE'), aE: sum('aE'), tracked: qs.filter(m => m.tracked).length };
        r.net = r.aS - r.aE;
        return r;
    });

    const budgetMonths = months.filter(m => m.budgetEvaluated);
    const savingsMonths = months.filter(m => m.savingsEvaluated);

    // Longest run of consecutive months at or under budget
    let streak = 0, bestStreak = 0, streakEnd = -1;
    months.forEach(m => {
        streak = m.underBudget ? streak + 1 : 0;
        if (streak > bestStreak) { bestStreak = streak; streakEnd = m.idx; }
    });

    const spendMonths = tracked.filter(m => m.aE > 0);
    const saveMonths = tracked.filter(m => m.aS > 0);
    const expenseItems = items.filter(i => i.type === 'expense');
    const savingsItems = items.filter(i => i.type === 'savings');

    const iraTarget = getIraTarget(year);
    const iraContributed = iraYearTotal(year);

    return {
        year, months, tracked, totals: t, cats, items, quarters,
        expenseStats: stats(spendMonths.map(m => m.aE)),
        savingsStats: stats(saveMonths.map(m => m.aS)),
        netStats: stats(tracked.map(m => m.net)),
        saveRatio: t.aS + t.aE > 0 ? (t.aS / (t.aS + t.aE)) * 100 : NaN,
        budget: { evaluated: budgetMonths.length, under: budgetMonths.filter(m => m.underBudget).length },
        savingsGoal: { evaluated: savingsMonths.length, hit: savingsMonths.filter(m => m.savingsHit).length },
        streak: { length: bestStreak, end: streakEnd },
        records: {
            bestNet: pickBy(tracked, m => m.net),
            worstNet: pickBy(tracked, m => -m.net),
            peakSpend: pickBy(spendMonths, m => m.aE),
            lowSpend: pickBy(spendMonths, m => -m.aE),
            peakSave: pickBy(saveMonths, m => m.aS),
            biggestOverrun: pickBy(expenseItems.filter(i => i.variance > 0), i => i.variance),
            biggestUnderrun: pickBy(expenseItems.filter(i => i.variance < 0), i => -i.variance),
            savingsBeat: pickBy(savingsItems.filter(i => i.variance > 0), i => i.variance),
            savingsMiss: pickBy(savingsItems.filter(i => i.variance < 0), i => -i.variance),
            steadiest: pickBy(expenseItems.filter(i => i.activeMonths >= 3), i => -i.cv),
            mostVolatile: pickBy(expenseItems.filter(i => i.activeMonths >= 3), i => i.cv),
            topExpense: pickBy(expenseItems.filter(i => i.a > 0), i => i.a),
            topSavings: pickBy(savingsItems.filter(i => i.a > 0), i => i.a),
        },
        ira: {
            target: iraTarget,
            contributed: iraContributed,
            pct: iraTarget > 0 ? (iraContributed / iraTarget) * 100 : NaN,
            monthsFunded: months.filter((m, i) => iraMonthContribution(year, i) > 0).length,
        },
    };
}

// ---- Annual report: rendering ----
// Year-over-year comparison. When the two years logged a different number of cycles,
// compare per-cycle averages so a partial year doesn't skew the result.
function deltaLine(field, r, prev, goodWhenUp, asDollars = false) {
    if (!prev || !prev.tracked.length) return '';
    const sameCoverage = r.tracked.length === prev.tracked.length;
    const cur = sameCoverage ? r.totals[field] : r.totals[field] / r.tracked.length;
    const old = sameCoverage ? prev.totals[field] : prev.totals[field] / prev.tracked.length;
    const basis = sameCoverage ? `VS ${prev.year}` : `AVG/CYCLE VS ${prev.year}`;
    const diff = cur - old;
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '◆';
    const cls = diff === 0 ? 'yoy-flat' : ((diff > 0) === goodWhenUp ? 'yoy-good' : 'yoy-bad');
    const amount = asDollars || !old ? fmtUSD(Math.abs(diff)) : fmtPct(Math.abs((diff / Math.abs(old)) * 100));
    return `<div class="yr-tile-yoy ${cls}">${arrow} ${amount} ${basis}</div>`;
}

function varianceClass(variance, type) {
    if (!variance) return 'diff-neutral';
    const good = type === 'savings' ? variance > 0 : variance < 0;
    return good ? 'diff-under' : 'diff-over';
}

function niceMax(v) {
    if (v <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(v));
    const step = [1, 2, 2.5, 5, 10].find(s => s * mag >= v);
    return step * mag;
}

function tipAttr(html) {
    return `data-tip="${escapeHtml(html)}" tabindex="0"`;
}

function renderMonthlyChart(r) {
    const max = niceMax(Math.max(...r.months.map(m => Math.max(m.aS, m.aE)), 0));
    const ticks = [1, 0.75, 0.5, 0.25, 0].map(f => max * f);
    const cols = r.months.map(m => {
        const tip = `<b>${MONTH_NAMES[m.idx].toUpperCase()} ${r.year}</b>`
            + `<div><i class="sw sw-save"></i>SAVED ${fmtUSD(m.aS)} <em>/ plan ${fmtUSD(m.pS)}</em></div>`
            + `<div><i class="sw sw-spend"></i>SPENT ${fmtUSD(m.aE)} <em>/ budget ${fmtUSD(m.pE)}</em></div>`
            + `<div>NET ${fmtSignedUSD(m.net)}</div>`;
        return `<div class="yr-col${m.tracked ? '' : ' is-empty'}" ${tipAttr(tip)}>
            <div class="yr-bar bar-save" style="height:${(m.aS / max) * 100}%"></div>
            <div class="yr-bar bar-spend" style="height:${(m.aE / max) * 100}%"></div>
        </div>`;
    }).join('');
    return `
        <div class="yr-legend">
            <span><i class="sw sw-save"></i>INVESTED / SAVED</span>
            <span><i class="sw sw-spend"></i>EXPENSES</span>
        </div>
        <div class="yr-chart">
            <div class="yr-yaxis">${ticks.map(v => `<span>${fmtCompact(v)}</span>`).join('')}</div>
            <div class="yr-plot">
                <div class="yr-grid">${ticks.map(() => '<i></i>').join('')}</div>
                <div class="yr-cols">${cols}</div>
            </div>
        </div>
        <div class="yr-xaxis">${MONTH_SHORT.map(s => `<span>${s}</span>`).join('')}</div>`;
}

function renderNetChart(r) {
    const nets = r.months.map(m => m.net);
    const hi = Math.max(0, ...nets), lo = Math.min(0, ...nets);
    const span = (hi - lo) || 1;
    const zeroPct = (hi / span) * 100; // distance of the zero line from the top
    const cols = r.months.map(m => {
        const h = (Math.abs(m.net) / span) * 100;
        const pos = m.net >= 0
            ? `bottom:${100 - zeroPct}%;height:${h}%`
            : `top:${zeroPct}%;height:${h}%`;
        const tip = `<b>${MONTH_NAMES[m.idx].toUpperCase()} ${r.year}</b><div>NET ${fmtSignedUSD(m.net)}</div>`;
        return `<div class="yr-col net-col${m.tracked ? '' : ' is-empty'}" ${tipAttr(tip)}>
            ${m.tracked ? `<div class="net-bar ${m.net >= 0 ? 'net-pos' : 'net-neg'}" style="${pos}"></div>` : ''}
        </div>`;
    }).join('');
    return `
        <div class="yr-chart yr-chart-net">
            <div class="yr-yaxis net-yaxis">
                <span style="top:0">${fmtCompact(hi)}</span>
                ${lo < 0 && hi > 0 ? `<span style="top:${zeroPct}%">$0</span>` : ''}
                <span style="top:100%">${fmtCompact(lo)}</span>
            </div>
            <div class="yr-plot">
                <div class="net-zero" style="top:${zeroPct}%"></div>
                <div class="yr-cols">${cols}</div>
            </div>
        </div>
        <div class="yr-xaxis">${MONTH_SHORT.map(s => `<span>${s}</span>`).join('')}</div>`;
}

function sparkline(series) {
    const max = Math.max(...series, 0) || 1;
    return `<div class="spark">${series.map((v, i) =>
        `<i class="${v > 0 ? '' : 'zero'}" style="height:${v > 0 ? Math.max(8, (v / max) * 100) : 4}%" title="${MONTH_SHORT[i]}: ${fmtUSD(v)}"></i>`
    ).join('')}</div>`;
}

function recordCard(label, value, detail, cls = '') {
    return `<div class="yr-record">
        <div class="yr-record-label">${label}</div>
        <div class="yr-record-value ${cls}">${value}</div>
        <div class="yr-record-detail">${detail}</div>
    </div>`;
}

function renderReview(year) {
    const r = computeYear(year);
    const prevHas = Object.keys(state.months).some(k => parseMonthKey(k).year === year - 1);
    const prev = prevHas ? computeYear(year - 1) : null;
    const t = r.totals;
    const view = document.getElementById('reviewView');

    if (!r.tracked.length) {
        view.innerHTML = `
            <section class="panel yr-hero">
                <div class="yr-hero-eyebrow">ANNUAL REPORT // ${year}</div>
                <h2 class="yr-hero-title">${year} YEAR IN REVIEW</h2>
                <p class="yr-empty">No actuals were logged for ${year} yet. Enter actual amounts in that year's cycles and this report fills itself in.</p>
            </section>`;
        return;
    }

    const budgetDiff = t.aE - t.pE;
    let verdictCls = 'on', verdict = '◆ ON BUDGET FOR THE YEAR';
    if (t.pE > 0 && budgetDiff > 0)      { verdictCls = 'over';  verdict = `▲ OVER BUDGET BY ${fmtUSD(budgetDiff)} FOR THE YEAR`; }
    else if (t.pE > 0 && budgetDiff < 0) { verdictCls = 'under'; verdict = `▼ UNDER BUDGET BY ${fmtUSD(-budgetDiff)} FOR THE YEAR`; }

    const firstIdx = r.tracked[0].idx, lastIdx = r.tracked[r.tracked.length - 1].idx;
    const coverage = `${r.tracked.length} OF 12 CYCLES WITH ACTUALS · ${MONTH_SHORT[firstIdx]}–${MONTH_SHORT[lastIdx]}`;

    const savePlanPct = t.pS > 0 ? (t.aS / t.pS) * 100 : NaN;
    const spendPlanPct = t.pE > 0 ? (t.aE / t.pE) * 100 : NaN;

    const tiles = [
        { label: 'TOTAL INVESTED / SAVED', value: fmtUSD(t.aS), sub: `${fmtPct(savePlanPct)} OF ${fmtUSD(t.pS)} PLANNED`, accent: 'accent-green', yoy: deltaLine('aS', r, prev, true) },
        { label: 'TOTAL EXPENSES', value: fmtUSD(t.aE), sub: `${fmtPct(spendPlanPct)} OF ${fmtUSD(t.pE)} BUDGETED`, accent: 'accent-red', yoy: deltaLine('aE', r, prev, false) },
        { label: 'NET (SAVED − SPENT)', value: fmtSignedUSD(t.net), valueCls: t.net < 0 ? 'negative' : 'positive', sub: `AVG ${fmtSignedUSD(r.netStats.mean)} / CYCLE`, accent: 'accent-cyan', yoy: deltaLine('net', r, prev, true, true) },
        { label: 'SHARE OF OUTFLOW SAVED', value: fmtPct(r.saveRatio), sub: `${fmtCompact(t.aS)} OF ${fmtCompact(t.aS + t.aE)} TOTAL OUTFLOW`, accent: 'accent-magenta', yoy: '' },
        { label: 'AVG MONTHLY SAVED', value: fmtUSD(r.savingsStats.mean), sub: `MEDIAN ${fmtUSD(r.savingsStats.median)}`, accent: 'accent-green', yoy: '' },
        { label: 'AVG MONTHLY SPEND', value: fmtUSD(r.expenseStats.mean), sub: `MEDIAN ${fmtUSD(r.expenseStats.median)} · ±${fmtUSD(r.expenseStats.sd)}`, accent: 'accent-red', yoy: '' },
        { label: 'BUDGET HIT RATE', value: r.budget.evaluated ? fmtPct((r.budget.under / r.budget.evaluated) * 100, 0) : '—', sub: `${r.budget.under} OF ${r.budget.evaluated} CYCLES AT/UNDER BUDGET`, accent: 'accent-cyan', yoy: '' },
        { label: 'SAVINGS GOAL HIT RATE', value: r.savingsGoal.evaluated ? fmtPct((r.savingsGoal.hit / r.savingsGoal.evaluated) * 100, 0) : '—', sub: `${r.savingsGoal.hit} OF ${r.savingsGoal.evaluated} CYCLES MET PLAN`, accent: 'accent-magenta', yoy: '' },
    ];

    const quarterRows = r.quarters.map(q => {
        const bv = q.aE - q.pE;
        return `<tr${q.tracked ? '' : ' class="is-empty"'}>
            <td class="yr-td-name">Q${q.q} <span class="yr-muted">${MONTH_SHORT[(q.q - 1) * 3]}–${MONTH_SHORT[(q.q - 1) * 3 + 2]}</span></td>
            <td>${fmtUSD(q.aS)}</td>
            <td>${fmtUSD(q.aE)}</td>
            <td class="${q.net < 0 ? 'diff-over' : q.net > 0 ? 'diff-under' : ''}">${fmtSignedUSD(q.net)}</td>
            <td class="${varianceClass(bv, 'expense')}">${q.pE > 0 ? fmtSignedUSD(bv) : '—'}</td>
            <td>${q.tracked}/3</td>
        </tr>`;
    }).join('');

    const halves = [[0, 1], [2, 3]].map(([a, b]) => {
        const qa = r.quarters[a], qb = r.quarters[b];
        return { aS: qa.aS + qb.aS, aE: qa.aE + qb.aE };
    });

    const rec = r.records;
    const mName = (m) => `${MONTH_NAMES[m.idx].toUpperCase()}`;
    const records = [
        rec.bestNet && recordCard('BEST CYCLE (NET)', mName(rec.bestNet), fmtSignedUSD(rec.bestNet.net), 'diff-under'),
        rec.worstNet && recordCard('TOUGHEST CYCLE (NET)', mName(rec.worstNet), fmtSignedUSD(rec.worstNet.net), 'diff-over'),
        rec.peakSave && recordCard('PEAK SAVINGS MONTH', mName(rec.peakSave), fmtUSD(rec.peakSave.aS)),
        rec.peakSpend && recordCard('PEAK SPENDING MONTH', mName(rec.peakSpend), fmtUSD(rec.peakSpend.aE)),
        rec.lowSpend && recordCard('LEANEST SPENDING MONTH', mName(rec.lowSpend), fmtUSD(rec.lowSpend.aE)),
        recordCard('LONGEST UNDER-BUDGET STREAK', `${r.streak.length} CYCLE${r.streak.length === 1 ? '' : 'S'}`,
            r.streak.length ? `${MONTH_SHORT[r.streak.end - r.streak.length + 1]}–${MONTH_SHORT[r.streak.end]}` : 'NO CYCLE CAME IN UNDER BUDGET'),
        rec.topExpense && recordCard('LARGEST EXPENSE LINE', rec.topExpense.name.toUpperCase(), `${fmtUSD(rec.topExpense.a)} · ${fmtPct(rec.topExpense.typeShare)} OF SPEND`),
        rec.topSavings && recordCard('LARGEST SAVINGS LINE', rec.topSavings.name.toUpperCase(), `${fmtUSD(rec.topSavings.a)} · ${fmtPct(rec.topSavings.typeShare)} OF SAVED`),
        rec.biggestOverrun && recordCard('BIGGEST OVERRUN', rec.biggestOverrun.name.toUpperCase(), `${fmtSignedUSD(rec.biggestOverrun.variance)} OVER PLAN`, 'diff-over'),
        rec.biggestUnderrun && recordCard('BIGGEST UNDERSPEND', rec.biggestUnderrun.name.toUpperCase(), `${fmtUSD(-rec.biggestUnderrun.variance)} UNDER PLAN`, 'diff-under'),
        rec.savingsBeat && recordCard('SAVINGS OVERACHIEVER', rec.savingsBeat.name.toUpperCase(), `${fmtSignedUSD(rec.savingsBeat.variance)} ABOVE PLAN`, 'diff-under'),
        rec.savingsMiss && recordCard('SAVINGS SHORTFALL', rec.savingsMiss.name.toUpperCase(), `${fmtUSD(-rec.savingsMiss.variance)} BELOW PLAN`, 'diff-over'),
        rec.steadiest && recordCard('STEADIEST EXPENSE', rec.steadiest.name.toUpperCase(), `±${fmtPct(rec.steadiest.cv, 0)} MONTH-TO-MONTH SWING`),
        rec.mostVolatile && rec.mostVolatile !== rec.steadiest && recordCard('MOST VOLATILE EXPENSE', rec.mostVolatile.name.toUpperCase(), `±${fmtPct(rec.mostVolatile.cv, 0)} MONTH-TO-MONTH SWING`),
    ].filter(Boolean).join('');

    const catRows = Object.entries(r.cats).map(([catKey, c]) => {
        const pct = c.p > 0 ? (c.a / c.p) * 100 : NaN;
        const typeTotal = c.type === 'savings' ? t.aS : t.aE;
        return `<div class="yr-cat">
            <div class="yr-cat-head">
                <span class="yr-cat-name">${c.title}</span>
                <span class="yr-cat-amt">${fmtUSD(c.a)} <span class="yr-muted">/ ${fmtUSD(c.p)}</span></span>
            </div>
            <div class="yr-meter ${c.type === 'savings' ? 'meter-save' : 'meter-spend'}"><i style="width:${Math.min(100, pct || 0)}%"></i></div>
            <div class="yr-cat-foot">
                <span>${fmtPct(pct)} OF PLAN</span>
                <span class="${varianceClass(c.variance, c.type)}">${fmtSignedUSD(c.variance)} VS PLAN</span>
                <span>${fmtPct(typeTotal > 0 ? (c.a / typeTotal) * 100 : NaN)} OF ${c.type === 'savings' ? 'SAVED' : 'SPEND'}</span>
            </div>
        </div>`;
    }).join('');

    const mixList = (type) => r.items
        .filter(i => i.type === type && i.a > 0)
        .sort((a, b) => b.a - a.a)
        .map(i => `<div class="yr-mix-row" ${tipAttr(`<b>${escapeHtml(i.name.toUpperCase())}</b><div>${fmtUSD(i.a)} · ${fmtPct(i.typeShare)}</div>`)}>
            <span class="yr-mix-name">${escapeHtml(i.name)}</span>
            <span class="yr-mix-track"><i class="${type === 'savings' ? 'bar-save' : 'bar-spend'}" style="width:${i.typeShare}%"></i></span>
            <span class="yr-mix-val">${fmtPct(i.typeShare)}</span>
        </div>`).join('') || '<div class="yr-muted">NO ACTUALS LOGGED</div>';

    const ledgerRows = Object.entries(CATEGORIES).map(([catKey, cat]) => {
        const rows = r.items.filter(i => i.catKey === catKey).map(i => `<tr${i.a || i.p ? '' : ' class="is-empty"'}>
            <td class="yr-td-name">${escapeHtml(i.name)}</td>
            <td>${fmtUSD(i.p)}</td>
            <td>${fmtUSD(i.a)}</td>
            <td class="${varianceClass(i.variance, i.type)}">${i.p || i.a ? fmtSignedUSD(i.variance) : '—'}</td>
            <td class="${varianceClass(i.variance, i.type)}">${Number.isFinite(i.variancePct) ? (i.variancePct > 0 ? '+' : '') + fmtPct(i.variancePct) : '—'}</td>
            <td>${i.activeMonths ? fmtUSD(i.avg) : '—'}</td>
            <td>${i.peakIdx >= 0 ? `${fmtUSD(i.peak)} <span class="yr-muted">${MONTH_SHORT[i.peakIdx]}</span>` : '—'}</td>
            <td>${i.activeMonths}/12</td>
            <td>${fmtPct(i.catShare)}</td>
            <td>${sparkline(i.series)}</td>
        </tr>`).join('');
        const c = r.cats[catKey];
        return `<tr class="yr-group"><td colspan="10">${cat.title}</td></tr>${rows}
            <tr class="yr-subtotal">
                <td class="yr-td-name">SUBTOTAL</td>
                <td>${fmtUSD(c.p)}</td>
                <td>${fmtUSD(c.a)}</td>
                <td class="${varianceClass(c.variance, c.type)}">${fmtSignedUSD(c.variance)}</td>
                <td class="${varianceClass(c.variance, c.type)}">${c.p > 0 ? (c.variance > 0 ? '+' : '') + fmtPct((c.variance / c.p) * 100) : '—'}</td>
                <td colspan="5"></td>
            </tr>`;
    }).join('');

    const ira = r.ira;
    const iraPct = Math.min(100, ira.pct || 0);
    const iraStatus = ira.contributed >= ira.target && ira.target > 0
        ? `<span class="diff-under">◆ MAXED OUT</span>`
        : `<span class="diff-over">${fmtUSD(Math.max(0, ira.target - ira.contributed))} LEFT UNFUNDED</span>`;

    view.innerHTML = `
        <section class="panel yr-hero">
            <div class="yr-hero-main">
                <div class="yr-hero-eyebrow">ANNUAL REPORT // ${coverage}</div>
                <h2 class="yr-hero-title">${year} YEAR IN REVIEW</h2>
                <div class="kpi-status ${verdictCls}">${verdict}</div>
            </div>
            <div class="yr-hero-net">
                <div class="kpi-label">ACTUAL NET // FULL YEAR</div>
                <div class="kpi-value kpi-xl ${t.net < 0 ? 'negative' : 'positive'}">${fmtSignedUSD(t.net)}</div>
            </div>
        </section>

        <section class="yr-tiles">
            ${tiles.map(tile => `<div class="kpi panel">
                <div class="kpi-label">${tile.label}</div>
                <div class="kpi-value ${tile.valueCls || ''}">${tile.value}</div>
                <div class="yr-tile-sub">${tile.sub}</div>
                ${tile.yoy || ''}
                <div class="kpi-accent ${tile.accent}"></div>
            </div>`).join('')}
        </section>

        <section class="panel">
            <div class="section-head"><h2>MONTHLY TREND // SAVED VS SPENT</h2><div class="section-totals">HOVER A MONTH FOR DETAIL</div></div>
            ${renderMonthlyChart(r)}
        </section>

        <div class="yr-two">
            <section class="panel">
                <div class="section-head"><h2>NET BY CYCLE</h2><div class="section-totals">SAVED − SPENT</div></div>
                ${renderNetChart(r)}
            </section>
            <section class="panel">
                <div class="section-head"><h2>QUARTERLY BREAKDOWN</h2>
                    <div class="section-totals">H1 NET ${fmtSignedUSD(halves[0].aS - halves[0].aE)} // H2 NET ${fmtSignedUSD(halves[1].aS - halves[1].aE)}</div>
                </div>
                <div class="yr-table-wrap">
                    <table class="yr-table">
                        <thead><tr><th>QTR</th><th>SAVED</th><th>SPENT</th><th>NET</th><th>VS BUDGET</th><th>LOGGED</th></tr></thead>
                        <tbody>${quarterRows}</tbody>
                    </table>
                </div>
            </section>
        </div>

        <section class="panel">
            <div class="section-head"><h2>RECORDS // HIGHLIGHTS</h2></div>
            <div class="yr-records">${records}</div>
        </section>

        <div class="yr-two">
            <section class="panel">
                <div class="section-head"><h2>CATEGORY PERFORMANCE</h2><div class="section-totals">ACTUAL / PLANNED</div></div>
                <div class="yr-cats">${catRows}</div>
            </section>
            <section class="panel">
                <div class="section-head"><h2>ROTH IRA // ${year} RESULT</h2></div>
                <div class="ira-stats yr-ira-stats">
                    <div class="ira-stat"><div class="ira-stat-label">CONTRIBUTED</div><div class="ira-stat-value">${fmtUSD(ira.contributed)}</div></div>
                    <div class="ira-stat"><div class="ira-stat-label">TARGET</div><div class="ira-stat-value">${fmtUSD(ira.target)}</div></div>
                    <div class="ira-stat"><div class="ira-stat-label">PROGRESS</div><div class="ira-stat-value">${fmtPct(ira.pct)}</div></div>
                    <div class="ira-stat"><div class="ira-stat-label">MONTHS FUNDED</div><div class="ira-stat-value">${ira.monthsFunded}/12</div></div>
                </div>
                <div class="progress-track"><div class="progress-fill" style="width:${iraPct}%"></div></div>
                <div class="yr-ira-status">${iraStatus}</div>
            </section>
        </div>

        <div class="yr-two">
            <section class="panel">
                <div class="section-head"><h2>SPENDING MIX</h2><div class="section-totals">${fmtUSD(t.aE)} TOTAL</div></div>
                <div class="yr-mix">${mixList('expense')}</div>
            </section>
            <section class="panel">
                <div class="section-head"><h2>SAVINGS ALLOCATION</h2><div class="section-totals">${fmtUSD(t.aS)} TOTAL</div></div>
                <div class="yr-mix">${mixList('savings')}</div>
            </section>
        </div>

        <section class="panel">
            <div class="section-head"><h2>LINE-ITEM LEDGER // ALL ITEMS</h2><div class="section-totals">VARIANCE = ACTUAL − PLANNED</div></div>
            <div class="yr-table-wrap">
                <table class="yr-table yr-ledger">
                    <thead><tr>
                        <th>ITEM</th><th>PLANNED</th><th>ACTUAL</th><th>VARIANCE</th><th>VAR %</th>
                        <th>AVG / ACTIVE MO</th><th>PEAK</th><th>ACTIVE</th><th>% OF CAT</th><th>JAN → DEC</th>
                    </tr></thead>
                    <tbody>${ledgerRows}</tbody>
                </table>
            </div>
        </section>`;
}

// ---- Chart tooltip ----
function wireChartTips() {
    const tip = document.getElementById('chartTip');
    const view = document.getElementById('reviewView');
    const show = (target, x, y) => {
        tip.innerHTML = target.dataset.tip;
        tip.classList.add('show');
        const pad = 12;
        const w = tip.offsetWidth, h = tip.offsetHeight;
        let left = x + pad, top = y - h - pad;
        if (left + w > window.innerWidth - 8) left = x - w - pad;
        if (left < 8) left = 8;
        if (top < 8) top = y + pad;
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    };
    const hide = () => tip.classList.remove('show');
    view.addEventListener('pointermove', (e) => {
        const target = e.target.closest('[data-tip]');
        if (target) show(target, e.clientX, e.clientY); else hide();
    });
    view.addEventListener('pointerleave', hide);
    view.addEventListener('focusin', (e) => {
        const target = e.target.closest('[data-tip]');
        if (!target) return;
        const r = target.getBoundingClientRect();
        show(target, r.left + r.width / 2, r.top);
    });
    view.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, { passive: true });
}

// ---- Month navigation ----
function shiftMonth(delta) {
    const entries = navEntries();
    const current = reviewYear !== null ? `review:${reviewYear}` : state.activeMonth;
    const idx = entries.findIndex(e => e.key === current);
    const target = entries[idx + delta];
    if (target) {
        if (target.type === 'review') openReview(target.year);
        else openMonth(target.key);
    } else {
        // Past either end of the list: create the adjacent month
        let { year, monthIdx } = parseMonthKey(state.activeMonth);
        if (delta > 0 && ++monthIdx > 11) { monthIdx = 0; year++; }
        if (delta < 0 && --monthIdx < 0)  { monthIdx = 11; year--; }
        openMonth(monthKey(year, monthIdx));
    }
    save();
    renderAll();
}

function addNewMonth() {
    const keys = sortedMonthKeys();
    const last = keys[keys.length - 1] || state.activeMonth;
    let { year, monthIdx } = parseMonthKey(last);
    if (++monthIdx > 11) { monthIdx = 0; year++; }
    const nk = monthKey(year, monthIdx);
    openMonth(nk);
    commit();
    renderAll();
    showToast(`NEW CYCLE CREATED // ${formatMonthLabel(nk)}`);
}

// ---- Card helpers ----
function updateCardDiff(catKey, itemId) {
    const cat = CATEGORIES[catKey];
    const v = getActiveMonth()[catKey][itemId];
    const diff = (Number(v.actual) || 0) - (Number(v.projected) || 0);
    const hasActual = Number(v.actual) > 0;
    const input = document.querySelector(`.amount-input[data-cat="${catKey}"][data-item="${itemId}"][data-kind="actual"]`);
    if (!input) return;
    const card = input.closest('.cat-item');
    const diffEl = card.querySelector('.cat-diff');
    let diffClass = 'diff-neutral', diffLabel = 'AWAITING ACTUAL';
    if (hasActual) {
        if (cat.type === 'savings') {
            if (diff > 0)      { diffClass = 'diff-under'; diffLabel = `+${fmtUSD(Math.abs(diff))} ABOVE`; }
            else if (diff < 0) { diffClass = 'diff-over';  diffLabel = `${fmtUSD(Math.abs(diff))} BELOW`; }
            else               { diffLabel = 'ON TARGET'; }
        } else {
            if (diff < 0)      { diffClass = 'diff-under'; diffLabel = `${fmtUSD(Math.abs(diff))} UNDER`; }
            else if (diff > 0) { diffClass = 'diff-over';  diffLabel = `+${fmtUSD(Math.abs(diff))} OVER`; }
            else               { diffLabel = 'ON TARGET'; }
        }
    }
    diffEl.className = `cat-diff ${diffClass}`;
    diffEl.innerHTML = `<span>${diffLabel}</span>`;
    card.classList.toggle('has-diff', hasActual && diff !== 0);
}

function updateCategoryTotals(catKey) {
    const p = sumProjected(catKey), a = sumActual(catKey);
    document.getElementById(`${catKey}Totals`).textContent = `PROJ ${fmtUSD(p)}  //  ACT ${fmtUSD(a)}`;
}

// ---- Toast / status ----
let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

let statusTimer = null;
function setSaveStatus(msg) {
    const el = document.getElementById('saveStatus');
    el.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = 'LOCAL STATE SYNCED'; }, 1500);
}

// ---- Event wiring ----
function wireEvents() {
    document.getElementById('prevMonth').addEventListener('click', () => shiftMonth(-1));
    document.getElementById('nextMonth').addEventListener('click', () => shiftMonth(1));
    document.getElementById('newMonthBtn').addEventListener('click', addNewMonth);
    document.getElementById('syncBtn').addEventListener('click', openSyncModal);
    wireChartTips();

    document.getElementById('monthSelect').addEventListener('change', (e) => {
        const val = e.target.value;
        if (val.startsWith('review:')) openReview(Number(val.slice(7)));
        else openMonth(val);
        save();
        renderAll();
    });

    document.getElementById('yearSelect').addEventListener('change', renderIraPanel);

    document.getElementById('iraTarget').addEventListener('input', (e) => {
        state.yearlyTargets[getIraYear()] = Number(e.target.value) || 0;
        commit();
        renderIraPanel();
    });

    document.body.addEventListener('input', (e) => {
        const el = e.target;
        if (!el.classList.contains('amount-input')) return;
        const { cat, item, kind } = el.dataset;
        getActiveMonth()[cat][item][kind] = Number(el.value) || 0;
        commit();
        renderSummary();
        updateCardDiff(cat, item);
        updateCategoryTotals(cat);
        if (cat === 'investments' && item === 'rothIra') renderIraPanel();
    });

    document.getElementById('notesField').addEventListener('input', (e) => {
        getActiveMonth().notes = e.target.value;
        commit();
    });

    document.addEventListener('keydown', (e) => {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === 'ArrowLeft')  shiftMonth(-1);
        if (e.key === 'ArrowRight') shiftMonth(1);
    });
}

// ---- Init ----
async function init() {
    const loaded = loadLocal();
    if (!loaded) {
        state.activeMonth = monthKey(2026, 3);
        ensureMonth(state.activeMonth);
        state.yearlyTargets[2026] = 7500;
        saveLocal();
    }
    if (!state.activeMonth || !state.months[state.activeMonth]) {
        const keys = sortedMonthKeys();
        state.activeMonth = keys[keys.length - 1] || monthKey(2026, 3);
        ensureMonth(state.activeMonth);
    }

    syncConfig = loadSyncConfig();
    wireEvents();
    renderAll();
    setInterval(renderLastUpdated, 30000);
    renderSyncBtn();

    if (syncConfig) {
        setSyncStatusLabel('LOADING...', 'syncing');
        await loadFromGist();
    } else {
        setSyncStatusLabel('CLOUD SYNC OFFLINE', 'offline');
    }
}

document.addEventListener('DOMContentLoaded', init);
