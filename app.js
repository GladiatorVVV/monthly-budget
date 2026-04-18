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
            { id: 'amexPlatinum', name: 'AMEX Platinum' },
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

// ---- Save (local + cloud) ----
function save() {
    saveLocal();
    scheduleSyncSave();
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
            const k = monthKey(year, i);
            ensureMonth(k);
            state.activeMonth = k;
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
    keys.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = formatMonthLabel(k);
        if (k === state.activeMonth) opt.selected = true;
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
    document.getElementById('versionTag').textContent = `v${year}.${monthIdx + 1}`;
}

function renderNotes() {
    document.getElementById('notesField').value = getActiveMonth().notes || '';
}

function renderAll() {
    renderMonthSelect();
    renderYearSelect();
    renderVersionTag();
    renderSummary();
    renderIraPanel();
    Object.keys(CATEGORIES).forEach(renderCategory);
    renderNotes();
}

// ---- Month navigation ----
function shiftMonth(delta) {
    const keys = sortedMonthKeys();
    const idx = keys.indexOf(state.activeMonth);
    if (delta > 0) {
        if (idx < keys.length - 1) {
            state.activeMonth = keys[idx + 1];
        } else {
            let { year, monthIdx } = parseMonthKey(state.activeMonth);
            if (++monthIdx > 11) { monthIdx = 0; year++; }
            const nk = monthKey(year, monthIdx);
            ensureMonth(nk);
            state.activeMonth = nk;
        }
    } else {
        if (idx > 0) {
            state.activeMonth = keys[idx - 1];
        } else {
            let { year, monthIdx } = parseMonthKey(state.activeMonth);
            if (--monthIdx < 0) { monthIdx = 11; year--; }
            const nk = monthKey(year, monthIdx);
            ensureMonth(nk);
            state.activeMonth = nk;
        }
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
    ensureMonth(nk);
    state.activeMonth = nk;
    save();
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

    document.getElementById('monthSelect').addEventListener('change', (e) => {
        state.activeMonth = e.target.value;
        save();
        renderAll();
    });

    document.getElementById('yearSelect').addEventListener('change', renderIraPanel);

    document.getElementById('iraTarget').addEventListener('input', (e) => {
        state.yearlyTargets[getIraYear()] = Number(e.target.value) || 0;
        save();
        renderIraPanel();
    });

    document.body.addEventListener('input', (e) => {
        const el = e.target;
        if (!el.classList.contains('amount-input')) return;
        const { cat, item, kind } = el.dataset;
        getActiveMonth()[cat][item][kind] = Number(el.value) || 0;
        save();
        renderSummary();
        updateCardDiff(cat, item);
        updateCategoryTotals(cat);
        if (cat === 'investments' && item === 'rothIra') renderIraPanel();
    });

    document.getElementById('notesField').addEventListener('input', (e) => {
        getActiveMonth().notes = e.target.value;
        save();
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
    renderSyncBtn();

    if (syncConfig) {
        setSyncStatusLabel('LOADING...', 'syncing');
        await loadFromGist();
    } else {
        setSyncStatusLabel('CLOUD SYNC OFFLINE', 'offline');
    }
}

document.addEventListener('DOMContentLoaded', init);
