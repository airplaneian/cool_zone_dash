/**
 * Cool Zone Situation Monitor - Data Fetching and Visualization
 */

// Formatters
function formatCurrency(val) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}
function formatNumber(val) {
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}
function formatChange(val) {
    return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
}
function formatDelta(val, units) {
    return units === 'bp' ? `${val > 0 ? '+' : ''}${val.toFixed(0)}bp` : formatChange(val);
}
function formatOrdinal(n) {
    const v = Math.round(n);
    const suffix = (v % 100 >= 11 && v % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
    return `${v}${suffix}`;
}
function formatDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
}
function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour12: false });
}
function formatClock(date) {
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
// After deploying the Cloudflare Worker, paste your worker URL here.
// It will look like:  https://yahoo-finance-proxy.<your-subdomain>.workers.dev
const WORKER_BASE_URL = 'https://yahoo-finance-proxy.ian-servin2010.workers.dev';

// Fetch the longest selectable history once; time windows slice it client-side
const FETCH_RANGE = '5y';

// Intraday: today's 1-minute bars, extended by live ticks from Yahoo's streaming feed
const INTRADAY = { range: '1d', interval: '1m', minPoints: 2, fresh: true };
const STREAM_URL = 'wss://streamer.finance.yahoo.com/?version=2';
const SESSIONS = { 0: 'PRE-MKT', 2: 'POST-MKT', 3: 'EXT HRS', 4: 'OVERNIGHT' };

const TIME_WINDOWS = [
    { key: '1D', days: 1, intraday: true },
    { key: '7D', days: 7 },
    { key: '30D', days: 30 },
    { key: '60D', days: 60 },
    { key: '90D', days: 90 },
    { key: '6M', days: 182 },
    { key: 'YTD', ytd: true },
    { key: '1Y', days: 365 },
    { key: '2Y', days: 730 },
    { key: '5Y', days: 1826 }
];

let activeWindow = TIME_WINDOWS.find(w => w.key === localStorage.getItem('timeWindow'))
    || TIME_WINDOWS.find(w => w.key === '1Y');

// Alert thresholds, calibrated so each alert fires on roughly 2-7% of days over a 5Y backtest
const DEFAULT_SETTINGS = {
    bandPeriod: 60,
    bandSigma: 2.5,
    momentumSigma: 2.0,
    concentrationPct: 90,
    creditDays: 30,
    creditYieldBp: 25,
    creditDropPct: 15,
    // Which way a move has to go to count as risk
    directions: { oil: 'up', soxx: 'both', treasury: 'up', owl: 'down' }
};

const DIRECTIONS = [
    { value: 'up', label: '▲ RISE' },
    { value: 'down', label: '▼ FALL' },
    { value: 'both', label: '▲▼ EITHER' }
];

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('alertSettings')) || {};
        return {
            ...DEFAULT_SETTINGS,
            ...saved,
            directions: { ...DEFAULT_SETTINGS.directions, ...saved.directions }
        };
    } catch (e) {
        return { ...DEFAULT_SETTINGS, directions: { ...DEFAULT_SETTINGS.directions } };
    }
}

function saveSettings() {
    localStorage.setItem('alertSettings', JSON.stringify(settings));
}

let settings = loadSettings();

// API Helper for real data (calls our own Cloudflare Worker proxy)
async function fetchYahooData(ticker, { range = FETCH_RANGE, interval = '1d', minPoints = 60, fresh = false } = {}) {
    const proxyUrl = `${WORKER_BASE_URL}/?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${interval}`;
    try {
        const res = await fetch(proxyUrl, fresh ? { cache: 'no-store' } : {});
        if (!res.ok) throw new Error(`Worker responded with ${res.status}`);

        const data = await res.json();

        if (!data || !data.chart || !data.chart.result) return null;

        const result = data.chart.result[0];
        const rawCloses = result.indicators.quote[0].close;
        // Dividend-adjusted closes, for total-return comparisons
        const rawAdjCloses = result.indicators.adjclose ? result.indicators.adjclose[0].adjclose : rawCloses;
        const timestamps = [];
        const closes = [];
        const adjCloses = [];
        result.timestamp.forEach((t, i) => {
            if (rawCloses[i] !== null) {
                timestamps.push(t);
                closes.push(rawCloses[i]);
                adjCloses.push(rawAdjCloses[i] ?? rawCloses[i]);
            }
        });
        const previousClose = result.meta.previousClose ?? result.meta.chartPreviousClose;
        // Only return if we have a robust dataset
        return closes.length > minPoints ? { timestamps, closes, adjCloses, previousClose } : null;
    } catch (e) {
        // Suppress console spam so the dashboard silently enters its background retry loop
        return null;
    }
}

const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const minuteKey = (t) => Math.floor(t / 60);

// Pair up two series on the periods (trading days by default) they share
function alignByDay(a, b, field, keyOf = dayKey) {
    const bByKey = new Map(b.timestamps.map((t, i) => [keyOf(t), b[field][i]]));
    const aligned = { timestamps: [], a: [], b: [] };
    a.timestamps.forEach((t, i) => {
        const bValue = bByKey.get(keyOf(t));
        if (bValue !== undefined) {
            aligned.timestamps.push(t);
            aligned.a.push(a[field][i]);
            aligned.b.push(bValue);
        }
    });
    return aligned;
}

// Configuration for indicators
const metrics = {
    oil: {
        id: 'metric-oil',
        layer: 'L1',
        title: 'Crude Oil (WTI)',
        ticker: 'CL=F',
        description: 'Energy prices serve as a proxy for the cost of physical movement.',
        formatter: formatCurrency,
        generate: () => fetchYahooData('CL=F'),
        type: 'standard'
    },
    soxx: {
        id: 'metric-soxx',
        layer: 'L1',
        title: 'Semiconductor ETF',
        ticker: 'SOXX',
        description: 'Semiconductor stocks act as a bellwether for global reliance on hardware supply chains.',
        formatter: formatCurrency,
        generate: () => fetchYahooData('SOXX'),
        type: 'standard'
    },
    sp500div: {
        id: 'metric-sp500-divergence',
        layer: 'L2',
        title: 'Market Concentration',
        ticker: 'SPY / RSP',
        symbols: ['SPY', 'RSP'],
        description: 'How much of the market\'s capital is tied up in a handful of megacap tech firms. A widening spread indicates building pressure as investments crowd into the AI infrastructure trade.',
        generate: async () => {
            const spy = await fetchYahooData('SPY');
            const rsp = await fetchYahooData('RSP');
            if (!spy || !rsp) return null;

            const aligned = alignByDay(spy, rsp, 'adjCloses');
            return aligned.timestamps.length > 60
                ? { timestamps: aligned.timestamps, spy: aligned.a, rsp: aligned.b }
                : null;
        },
        type: 'divergence'
    },
    treasury: {
        id: 'metric-treasury',
        layer: 'L3',
        title: '10-Year Treasury Yield',
        ticker: '^TNX',
        description: 'The cost of capital. When yields pull higher while private credit sentiment drops, debt markets may be in trouble.',
        formatter: (val) => formatNumber(val) + '%',
        units: 'bp',
        generate: () => fetchYahooData('^TNX'),
        type: 'standard'
    },
    owl: {
        id: 'metric-owl',
        layer: 'L3',
        title: 'Blue Owl Capital',
        ticker: 'OWL',
        description: 'A proxy for the structural health of non-bank (private credit) lenders.',
        formatter: formatCurrency,
        generate: () => fetchYahooData('OWL'),
        type: 'standard'
    }
};
Object.entries(metrics).forEach(([key, config]) => {
    config.key = key;
    config.symbols = config.symbols || [config.ticker];
});

const standardMetrics = () => Object.values(metrics).filter(c => c.type === 'standard');

/**
 * UTILITY & MATH
 */

const last = (arr) => arr[arr.length - 1];

// Change in percent, or in basis points for yields
function delta(current, past, units) {
    return units === 'bp' ? (current - past) * 100 : ((current - past) / past) * 100;
}

// Change at each point versus the last point at least `days` calendar days earlier
function changeSeries(timestamps, values, days, units) {
    const changes = [];
    let j = 0;
    for (let i = 0; i < values.length; i++) {
        const cutoff = timestamps[i] - days * 86400;
        if (timestamps[0] > cutoff) continue;
        while (timestamps[j + 1] <= cutoff) j++;
        changes.push(delta(values[i], values[j], units));
    }
    return changes;
}

function zScores(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length) || 1;
    return values.map(v => (v - mean) / sd);
}

// True when a z-score breaks the threshold in the given risk direction
function breaches(z, threshold, direction) {
    return (direction !== 'down' && z > threshold) || (direction !== 'up' && z < -threshold);
}

const shareOf = (flags) => flags.filter(Boolean).length / (flags.length || 1);

// Mean ± multiplier·σ of the `period` points before each point.
// The point itself is excluded so a breakout can't dampen its own test.
function calculateRollingBands(data, period = 60, multiplier = 2) {
    const bands = [];
    for (let i = 0; i < data.length; i++) {
        const slice = data.slice(Math.max(0, i - period), Math.max(1, i));
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
        const stdDev = Math.sqrt(variance);

        // If variance is 0 (first data point), give it a tiny buffer
        const sd = stdDev === 0 ? mean * 0.02 : stdDev;

        bands.push({
            upper: mean + multiplier * sd,
            lower: mean - multiplier * sd,
            mean: mean,
            sd: sd
        });
    }
    return bands;
}

function windowCutoff(win) {
    const now = new Date();
    return win.ytd
        ? new Date(now.getFullYear(), 0, 1)
        : new Date(now.getTime() - win.days * 86400 * 1000);
}

// Index of the first data point inside the window (always leaves at least 2 points)
function windowStartIndex(timestamps, win) {
    const cutoff = windowCutoff(win).getTime() / 1000;
    const idx = timestamps.findIndex(t => t >= cutoff);
    const lastStart = Math.max(0, timestamps.length - 2);
    return idx === -1 ? lastStart : Math.min(idx, lastStart);
}

/**
 * ALERT EVALUATION
 * Alerts use the full history, so they don't change with the selected time window.
 * Each alert is { text, cls, detail }; cls 'status-alert' turns the panel border red.
 */

function analyzeStandard(data, config) {
    const { bandPeriod, bandSigma, momentumSigma } = settings;
    const direction = settings.directions[config.key];
    const units = config.units;
    const closes = data.closes;
    const current = last(closes);

    const bands = calculateRollingBands(closes, bandPeriod, bandSigma);
    const bandZ = closes.map((v, i) => (v - bands[i].mean) / bands[i].sd);
    const z = last(bandZ);
    const bandText = z > 0 ? 'ABOVE BAND' : 'BELOW BAND';
    const bandDetail = `Last ${config.formatter(current)} is ${z.toFixed(1)}σ from its ${bandPeriod}-day mean of ${config.formatter(last(bands).mean)} (threshold ${bandSigma}σ).`;

    const chg30 = changeSeries(data.timestamps, closes, 30, units);
    const chg90 = changeSeries(data.timestamps, closes, 90, units);
    const z30 = zScores(chg30);
    const z90 = zScores(chg90);
    const moves = [
        { days: 30, chg: last(chg30), z: last(z30) },
        { days: 90, chg: last(chg90), z: last(z90) }
    ];
    const momentumDetail = (m) =>
        `${m.days}-day change of ${formatDelta(m.chg, units)} is ${m.z.toFixed(1)}σ vs. all ${m.days}-day changes in the loaded history (threshold ${momentumSigma}σ).`;
    const momentumHit = moves.find(m => breaches(m.z, momentumSigma, direction));
    const momentumMuted = moves.find(m => breaches(m.z, momentumSigma, 'both'));

    const alerts = [];
    if (breaches(z, bandSigma, direction)) {
        alerts.push({ text: bandText, cls: 'status-alert', detail: bandDetail });
    }
    if (momentumHit) {
        alerts.push({ text: `MOMENTUM ${momentumHit.z > 0 ? '▲' : '▼'}`, cls: 'status-warn', detail: momentumDetail(momentumHit) });
    }

    const benign = ' Outside the risk direction, so not an alert.';
    let status = alerts[0];
    if (!status && breaches(z, bandSigma, 'both')) {
        status = { text: bandText, cls: 'status-muted', detail: bandDetail + benign };
    } else if (!status && momentumMuted) {
        status = { text: `MOMENTUM ${momentumMuted.z > 0 ? '▲' : '▼'}`, cls: 'status-muted', detail: momentumDetail(momentumMuted) + benign };
    } else if (!status) {
        status = { text: 'IN RANGE', cls: '', detail: 'No alert conditions met.' };
    }

    // Share of past days each alert would have fired, for the settings panel
    const offset = z30.length - z90.length;
    const rates = {
        band: shareOf(bandZ.slice(bandPeriod).map(v => breaches(v, bandSigma, direction))),
        momentum: shareOf(z90.map((v, k) => breaches(v, momentumSigma, direction) || breaches(z30[k + offset], momentumSigma, direction)))
    };

    return { current, bands, moves, momentumHit, alerts, status, rates };
}

function analyzeConcentration(data) {
    const ratio = data.spy.map((v, i) => v / data.rsp[i]);
    const current = last(ratio);
    const percentile = (ratio.filter(r => r <= current).length / ratio.length) * 100;
    const threshold = settings.concentrationPct;
    const detail = `SPY/RSP ratio of ${current.toFixed(3)} sits at the ${formatOrdinal(percentile)} percentile of its 5Y range (threshold ${formatOrdinal(threshold)}).`;

    const alerts = percentile >= threshold ? [{ text: 'CONCENTRATED', cls: 'status-alert', detail }] : [];
    let status = alerts[0];
    if (!status && percentile <= 100 - threshold) {
        status = { text: 'BROADENING', cls: 'status-muted', detail };
    } else if (!status) {
        status = { text: 'NORMAL', cls: '', detail };
    }
    return { percentile, alerts, status };
}

// Layer 3 combined signal: yields rising while private credit falls over the same period
function analyzeCredit() {
    const treasury = metrics.treasury.data;
    const owl = metrics.owl.data;
    if (!treasury || !owl) return null;

    const { creditDays, creditYieldBp, creditDropPct } = settings;
    const aligned = alignByDay(treasury, owl, 'closes');
    const yieldChg = changeSeries(aligned.timestamps, aligned.a, creditDays, 'bp');
    const owlChg = changeSeries(aligned.timestamps, aligned.b, creditDays);
    const hits = yieldChg.map((y, i) => y >= creditYieldBp && owlChg[i] <= -creditDropPct);

    const detail = `Over ${creditDays} days the 10Y yield moved ${formatDelta(last(yieldChg), 'bp')} (trigger ≥ +${creditYieldBp}bp) while OWL moved ${formatChange(last(owlChg))} (trigger ≤ −${creditDropPct}%).`;
    return {
        alert: last(hits) ? { text: 'CREDIT STRESS', cls: 'status-alert', detail } : null,
        detail,
        rate: shareOf(hits)
    };
}

/**
 * VISUALIZATION SVG RENDERERS
 */

const PLOT_WIDTH = 800;
const PLOT_HEIGHT = 200;

// series: [{ values, cls }] (first series gets the last-value tag), area: { upper, lower, cls },
// reference: a dashed horizontal line (e.g. previous close)
function renderChart({ series, area, reference, timestamps, intraday = false }) {
    const all = series.flatMap(s => s.values);
    if (area) all.push(...area.upper, ...area.lower);
    if (reference !== undefined) all.push(reference);

    let min = Math.min(...all);
    let max = Math.max(...all);
    const pad = ((max - min) || 1) * 0.08;
    min -= pad;
    max += pad;
    const range = max - min;

    const n = timestamps.length;
    const scaleX = (i) => (i / (n - 1)) * PLOT_WIDTH;
    const scaleY = (v) => PLOT_HEIGHT - ((v - min) / range) * PLOT_HEIGHT;
    const topPct = (v) => ((max - v) / range) * 100;
    const toPath = (values) => values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(v)}`).join(' ');

    const ticks = [0.2, 0.4, 0.6, 0.8].map(f => min + range * f);
    const gridLines = ticks.map(v =>
        `<line class="grid-line" x1="0" x2="${PLOT_WIDTH}" y1="${scaleY(v)}" y2="${scaleY(v)}"></line>`
    ).join('');

    let areaPath = '';
    if (area) {
        const lowerReversed = area.lower.map((v, i) => `L ${scaleX(i)} ${scaleY(v)}`).reverse().join(' ');
        areaPath = `<path class="${area.cls}" d="${toPath(area.upper)} ${lowerReversed} Z"></path>`;
    }

    const linePaths = series.map(s => `<path class="svg-line ${s.cls || ''}" d="${toPath(s.values)}"></path>`).join('');
    const referenceLine = reference === undefined ? '' :
        `<line class="reference-line" x1="0" x2="${PLOT_WIDTH}" y1="${scaleY(reference)}" y2="${scaleY(reference)}"></line>`;

    const primary = series[0].values;
    const lastValue = last(primary);
    const formatLabel = intraday ? formatClock : formatDate;
    const dates = [timestamps[0], timestamps[Math.floor((n - 1) / 2)], timestamps[n - 1]]
        .map(t => `<span>${formatLabel(new Date(t * 1000))}</span>`).join('');

    return `
        <div class="chart">
            <div class="plot">
                <svg viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" preserveAspectRatio="none">
                    ${gridLines}
                    ${areaPath}
                    ${referenceLine}
                    ${linePaths}
                </svg>
            </div>
            <div class="y-axis">
                ${ticks.map(v => `<span class="y-tick" style="top: ${topPct(v)}%">${formatNumber(v)}</span>`).join('')}
                <span class="y-last" style="top: ${topPct(lastValue)}%">${formatNumber(lastValue)}</span>
            </div>
            <div class="x-axis">${dates}</div>
        </div>
    `;
}

/**
 * COMPONENT GENERATION
 */

function renderPanelHead(config, status) {
    return `
        <div class="panel-head" title="${config.description}">
            <span class="panel-layer">${config.layer}</span>
            <span class="panel-title">${config.title}</span>
            <span class="panel-ticker">${config.ticker}</span>
            <span class="panel-status ${status.cls}" title="${status.detail || ''}">${status.text}</span>
        </div>
    `;
}

function renderStat(label, value, cls = '', title = '') {
    return `
        <div class="stat" title="${title}">
            <span class="stat-label">${label}</span>
            <span class="stat-value ${cls}">${value}</span>
        </div>
    `;
}

// Green/red by direction; flagged (inverted) when the move raised an alert
function changeClass(val, flagged = false) {
    const direction = val >= 0 ? 'up' : 'down';
    return flagged ? `${direction} flag` : direction;
}

function renderPlaceholder(config, statusText, message) {
    return `
        ${renderPanelHead(config, { text: statusText, cls: '' })}
        <div class="panel-message">${message}</div>
    `;
}

function buildMetricCard(metricData, config, container) {
    config.analysis = config.type === 'divergence'
        ? analyzeConcentration(metricData)
        : analyzeStandard(metricData, config);
    container.classList.toggle('alert', config.analysis.alerts.some(a => a.cls === 'status-alert'));

    return config.type === 'divergence'
        ? buildDivergenceCard(metricData, config)
        : buildStandardCard(metricData, config);
}

function buildDivergenceCard(data, config) {
    const analysis = config.analysis;
    const isAlert = analysis.alerts.length > 0;

    // Rebase both series to 100: at the previous close intraday, otherwise at the start of the window
    const view = intradayView(config);
    let timestamps, capWeight, equalWeight;
    if (view) {
        timestamps = view.timestamps;
        capWeight = view.spy.map(v => (v / view.spyPrev) * 100);
        equalWeight = view.rsp.map(v => (v / view.rspPrev) * 100);
    } else {
        const start = windowStartIndex(data.timestamps, activeWindow);
        timestamps = data.timestamps.slice(start);
        capWeight = data.spy.slice(start).map(v => (v / data.spy[start]) * 100);
        equalWeight = data.rsp.slice(start).map(v => (v / data.rsp[start]) * 100);
    }
    const spread = ((last(capWeight) - last(equalWeight)) / last(equalWeight)) * 100;
    const spyChg = last(capWeight) - 100;
    const rspChg = last(equalWeight) - 100;

    return `
        ${renderPanelHead(config, analysis.status)}
        <div class="panel-quote">
            <span class="quote-label">SPREAD</span>
            <span class="quote-last ${flashClass(config)}">${formatChange(spread)}</span>
            <span class="quote-window">${activeWindow.key}</span>
            <div class="legend">
                <span class="legend-item"><span class="legend-swatch"></span>S&P 500 CAP WT</span>
                <span class="legend-item"><span class="legend-swatch secondary"></span>S&P 500 EQUAL WT</span>
            </div>
        </div>
        ${renderChart({
            series: [{ values: capWeight }, { values: equalWeight, cls: 'secondary-line' }],
            area: { upper: capWeight, lower: equalWeight, cls: 'divergence-band' },
            reference: view ? 100 : undefined,
            timestamps,
            intraday: !!view
        })}
        <div class="stats">
            ${renderStat(`SPY ${activeWindow.key}`, formatChange(spyChg), changeClass(spyChg))}
            ${renderStat(`RSP ${activeWindow.key}`, formatChange(rspChg), changeClass(rspChg))}
            ${renderStat('RATIO 5Y PCTL', analysis.percentile.toFixed(0), isAlert ? 'alert-text' : '', analysis.status.detail)}
        </div>
    `;
}

function buildStandardCard(data, config) {
    const analysis = config.analysis;
    const isBandAlert = analysis.alerts.some(a => a.cls === 'status-alert');

    // Intraday shows today's bars against the previous close; alerts stay on daily data
    const view = intradayView(config);
    let timestamps, values, base, area;
    if (view) {
        ({ timestamps, closes: values, previousClose: base } = view);
    } else {
        const start = windowStartIndex(data.timestamps, activeWindow);
        const windowBands = analysis.bands.slice(start);
        timestamps = data.timestamps.slice(start);
        values = data.closes.slice(start);
        base = values[0];
        area = { upper: windowBands.map(b => b.upper), lower: windowBands.map(b => b.lower), cls: 'svg-band' };
    }
    const price = last(values);
    const windowChg = delta(price, base, config.units);
    const tick = flashClass(config);
    const session = view && SESSIONS[config.session] ? `<span class="quote-session">${SESSIONS[config.session]}</span>` : '';

    const moveStats = analysis.moves.map(m => renderStat(
        `${m.days}D CHG`,
        formatDelta(m.chg, config.units),
        changeClass(m.chg, m === analysis.momentumHit),
        `${m.z.toFixed(1)}σ vs. history`
    )).join('');

    return `
        ${renderPanelHead(config, analysis.status)}
        <div class="panel-quote">
            <span class="quote-last ${isBandAlert ? 'alert-text' : ''} ${tick}">${config.formatter(price)}</span>
            <span class="quote-change ${changeClass(windowChg)}">${formatDelta(windowChg, config.units)}</span>
            <span class="quote-window">${activeWindow.key}</span>
            ${session}
        </div>
        ${renderChart({
            series: [{ values }],
            area,
            reference: view ? base : undefined,
            timestamps,
            intraday: !!view
        })}
        <div class="stats">
            ${renderStat('HI', config.formatter(Math.max(...values)))}
            ${renderStat('LO', config.formatter(Math.min(...values)))}
            ${moveStats}
        </div>
    `;
}

function renderAlertStrip() {
    const alerts = [];
    for (const config of Object.values(metrics)) {
        if (!config.analysis) continue;
        config.analysis.alerts.forEach(a => alerts.push({ ...a, text: `${config.ticker} ${a.text}` }));
    }
    const credit = analyzeCredit();
    if (credit && credit.alert) alerts.unshift(credit.alert);

    document.getElementById('alert-list').innerHTML = alerts.length
        ? alerts.map(a => `<span class="alert-chip ${a.cls}" title="${a.detail}">${a.text}</span>`).join('')
        : '<span class="alert-none">NO ACTIVE ALERTS</span>';
}

/**
 * INTRADAY STREAMING
 */

let stream = null;
let streamRetry = null;
let streamBackoff = 5000;
let intradayTimers = [];

const intradayView = (config) => (activeWindow.intraday && config.intraday) || null;

const directionOf = (previous, next) => next > previous ? 'up' : next < previous ? 'down' : 'same';

// One-shot flash on the next render after new data arrives
function flashClass(config) {
    const cls = config.flash ? `tick-${config.flash}` : '';
    config.flash = null;
    return cls;
}

// The spread rises when SPY ticks up and falls when RSP does
function spreadDirection(index, priceDirection) {
    if (index === 0 || priceDirection === 'same') return priceDirection;
    return priceDirection === 'up' ? 'down' : 'up';
}

async function loadIntraday(config) {
    const series = await Promise.all(config.symbols.map(s => fetchYahooData(s, INTRADAY)));
    if (series.some(s => !s)) return;
    const hadData = !!config.intraday;

    if (config.type === 'divergence') {
        const [spy, rsp] = series;
        const aligned = alignByDay(spy, rsp, 'closes', minuteKey);
        if (aligned.timestamps.length < 2) return;
        config.intraday = {
            timestamps: aligned.timestamps, spy: aligned.a, rsp: aligned.b,
            spyPrev: spy.previousClose, rspPrev: rsp.previousClose
        };
    } else {
        const [s] = series;
        const previous = hadData ? last(config.intraday.closes) : null;
        config.intraday = { timestamps: s.timestamps, closes: s.closes, previousClose: s.previousClose };
        if (hadData) config.flash = directionOf(previous, last(s.closes));
    }
    if (hadData && !config.flash) config.flash = 'same';
    if (config.data && activeWindow.intraday) renderCard(config);
}

async function loadAllIntraday() {
    for (const config of Object.values(metrics)) {
        await loadIntraday(config);
    }
}

// Minimal decoder for Yahoo's PricingData protobuf: 1 id, 2 price (float), 3 time (sint64 ms), 7 market session
function decodePricing(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    let pos = 0;
    const varint = () => {
        let result = 0, multiplier = 1, byte;
        do {
            byte = bytes[pos++];
            result += (byte & 0x7f) * multiplier;
            multiplier *= 128;
        } while (byte & 0x80);
        return result;
    };

    const tick = {};
    while (pos < bytes.length) {
        const tag = varint();
        const field = Math.floor(tag / 8);
        const wireType = tag % 8;
        if (wireType === 0) {
            const value = varint();
            if (field === 3) tick.time = value % 2 === 0 ? value / 2 : -(value + 1) / 2;
            if (field === 7) tick.session = value;
        } else if (wireType === 5) {
            if (field === 2) tick.price = view.getFloat32(pos, true);
            pos += 4;
        } else if (wireType === 1) {
            pos += 8;
        } else if (wireType === 2) {
            const length = varint();
            if (field === 1) tick.id = new TextDecoder().decode(bytes.subarray(pos, pos + length));
            pos += length;
        } else {
            break;
        }
    }
    return tick;
}

// Fold a tick into the current 1-minute bar, or open a new bar
function applyTick({ id, price, time, session }) {
    if (!id || !price || !time) return;
    const t = Math.floor(time / 1000);

    for (const config of Object.values(metrics)) {
        const d = config.intraday;
        const index = config.symbols.indexOf(id);
        if (!d || index === -1) continue;

        const lastMinute = minuteKey(last(d.timestamps));
        if (minuteKey(t) < lastMinute) continue;

        const fields = config.type === 'divergence' ? ['spy', 'rsp'] : ['closes'];
        const target = fields[index];
        config.flash = spreadDirection(index, directionOf(last(d[target]), price));
        if (minuteKey(t) === lastMinute) {
            d[target][d[target].length - 1] = price;
        } else {
            d.timestamps.push(t);
            fields.forEach(f => d[f].push(f === target ? price : last(d[f])));
        }
        config.session = session;
        config.dirty = true;
    }
}

function flushTicks() {
    for (const config of Object.values(metrics)) {
        if (config.dirty && config.data) {
            config.dirty = false;
            renderCard(config);
        }
    }
}

function setStreamStatus(text, cls = '') {
    const el = document.getElementById('stream-status');
    el.textContent = text;
    el.className = `stream-status ${cls}`;
}

function connectStream() {
    const ws = new WebSocket(STREAM_URL);
    stream = ws;
    setStreamStatus('STREAM CONNECTING', 'pending');

    ws.onopen = () => {
        streamBackoff = 5000;
        ws.send(JSON.stringify({ subscribe: [...new Set(Object.values(metrics).flatMap(c => c.symbols))] }));
        setStreamStatus('STREAM OPEN · WAITING FOR TICKS', 'pending');
    };
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'pricing') return;
        const tick = decodePricing(msg.message);
        applyTick(tick);
        setStreamStatus(`STREAMING · ${tick.id} ${formatTime(new Date(tick.time))}`, 'live');
    };
    ws.onclose = () => {
        // A deliberate stopIntraday() clears `stream` first, so only unexpected drops reconnect
        if (stream !== ws) return;
        setStreamStatus(`STREAM DOWN · RETRY IN ${streamBackoff / 1000}S · POLLING 1M BARS`, 'down');
        streamRetry = setTimeout(() => {
            loadAllIntraday();
            connectStream();
        }, streamBackoff);
        streamBackoff = Math.min(streamBackoff * 2, 60000);
    };
}

function startIntraday() {
    stopIntraday();
    loadAllIntraday();
    connectStream();
    intradayTimers = [
        setInterval(flushTicks, 1000),
        // Fallback: refresh 1-minute bars whenever the stream isn't open
        setInterval(() => {
            if (!stream || stream.readyState !== WebSocket.OPEN) loadAllIntraday();
        }, 60000)
    ];
}

function stopIntraday() {
    intradayTimers.forEach(clearInterval);
    intradayTimers = [];
    clearTimeout(streamRetry);
    if (stream) {
        const ws = stream;
        stream = null;
        ws.close();
    }
    setStreamStatus('');
}

/**
 * TIME WINDOW CONTROLS
 */

function renderWindowBar() {
    const bar = document.getElementById('window-bar');
    bar.innerHTML = TIME_WINDOWS.map(w =>
        `<button class="window-btn ${w === activeWindow ? 'active' : ''}" data-window="${w.key}">${w.key}</button>`
    ).join('');
    document.getElementById('window-dates').textContent = activeWindow.intraday
        ? 'TODAY · 1M BARS + LIVE TICKS'
        : `${formatDate(windowCutoff(activeWindow))} – ${formatDate(new Date())}`;
}

function setActiveWindow(key) {
    const wasIntraday = activeWindow.intraday;
    activeWindow = TIME_WINDOWS.find(w => w.key === key);
    localStorage.setItem('timeWindow', key);
    renderWindowBar();
    if (activeWindow.intraday && !wasIntraday) startIntraday();
    if (!activeWindow.intraday && wasIntraday) stopIntraday();
    rerenderAll();
}

document.getElementById('window-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.window-btn');
    if (btn) setActiveWindow(btn.dataset.window);
});

/**
 * ALERT SETTINGS PANEL
 */

function renderSettingsPanel() {
    const field = (key, label, unit, min, max, step) => `
        <label class="cfg-field">
            <span class="cfg-label">${label}</span>
            <input type="number" data-setting="${key}" value="${settings[key]}" min="${min}" max="${max}" step="${step}">
            <span class="cfg-unit">${unit}</span>
        </label>
    `;
    const directionField = (config) => `
        <label class="cfg-field">
            <span class="cfg-label">${config.ticker}</span>
            <select data-direction="${config.key}">
                ${DIRECTIONS.map(d => `<option value="${d.value}" ${settings.directions[config.key] === d.value ? 'selected' : ''}>${d.label}</option>`).join('')}
            </select>
        </label>
    `;

    document.getElementById('cfg-body').innerHTML = `
        <section class="cfg-section">
            <h3>Price Band <span class="cfg-tag status-alert">ALERT</span></h3>
            <p>Flags a breakout from the recent trading channel: today's price versus the mean ± σ of the
                prior trading days. Today is left out of its own band so a sharp move can't dampen the test.
                Turns the panel border red. The shaded channel on each chart is this band.</p>
            ${field('bandPeriod', 'Lookback', 'trading days', 10, 250, 1)}
            ${field('bandSigma', 'Width', 'σ', 1, 5, 0.1)}
            <div class="cfg-rate" id="rate-band"></div>
        </section>

        <section class="cfg-section">
            <h3>Momentum <span class="cfg-tag status-warn">WARN</span></h3>
            <p>Flags an unusually fast move. The 30-day and 90-day changes are scored against every other
                30-day and 90-day change in the loaded history, so each asset is judged on its own volatility:
                a big move for the 10Y yield (in bp) is far smaller than a big move for OWL.</p>
            ${field('momentumSigma', 'Threshold', 'σ', 1, 5, 0.1)}
            <div class="cfg-rate" id="rate-momentum"></div>
        </section>

        <section class="cfg-section">
            <h3>Risk Direction</h3>
            <p>Only moves in the risk direction raise band and momentum alerts. A break the other way is
                still shown on the panel, greyed out. Defaults: oil and yields are risky when rising,
                OWL when falling, SOXX either way (a crash or a melt-up).</p>
            ${standardMetrics().map(directionField).join('')}
        </section>

        <section class="cfg-section">
            <h3>Market Concentration <span class="cfg-tag status-alert">ALERT</span></h3>
            <p>Compares the cap-weighted S&P 500 (SPY) with its equal-weight twin (RSP), using
                dividend-adjusted prices. The SPY/RSP ratio climbs as megacaps pull away from the rest.
                Alerts when today's ratio is above this percentile of its 5Y range. This is a level test,
                so concentration that builds and then holds stays flagged.</p>
            ${field('concentrationPct', 'Percentile', 'th', 50, 99, 1)}
            <div class="cfg-rate" id="rate-concentration"></div>
        </section>

        <section class="cfg-section">
            <h3>Credit Stress <span class="cfg-tag status-alert">ALERT</span></h3>
            <p>The Layer 3 combined signal: the cost of capital rising (10Y yield up) while private credit
                sentiment falls (OWL down) over the same period. Shown in the alert strip.</p>
            ${field('creditDays', 'Period', 'calendar days', 5, 180, 1)}
            ${field('creditYieldBp', 'Yield rise ≥', 'bp', 1, 200, 1)}
            ${field('creditDropPct', 'OWL drop ≥', '%', 1, 80, 1)}
            <div class="cfg-rate" id="rate-credit"></div>
        </section>
    `;
    renderRates();
}

const formatRate = (r) => `${(r * 100).toFixed(1)}%`;

// Live backtest: share of days in the loaded history each alert would have fired
function renderRates() {
    const bandEl = document.getElementById('rate-band');
    if (!bandEl) return;

    const loaded = standardMetrics().filter(c => c.analysis);
    const perMetric = (key) => loaded.length
        ? 'FIRES ON ' + loaded.map(c => `${c.ticker} ${formatRate(c.analysis.rates[key])}`).join(' · ') + ' OF DAYS'
        : 'WAITING FOR DATA…';

    bandEl.textContent = perMetric('band');
    document.getElementById('rate-momentum').textContent = perMetric('momentum');

    const concentration = metrics.sp500div.analysis;
    document.getElementById('rate-concentration').textContent = concentration
        ? `NOW AT ${formatOrdinal(concentration.percentile).toUpperCase()} PCTL · ABOVE THIS LEVEL ON ${100 - settings.concentrationPct}% OF DAYS`
        : 'WAITING FOR DATA…';

    const credit = analyzeCredit();
    document.getElementById('rate-credit').textContent = credit
        ? `FIRES ON ${formatRate(credit.rate)} OF DAYS · NOW: ${credit.detail}`
        : 'WAITING FOR DATA…';
}

function openSettings() {
    renderSettingsPanel();
    document.getElementById('cfg').hidden = false;
}

function closeSettings() {
    document.getElementById('cfg').hidden = true;
}

document.getElementById('cfg-open').addEventListener('click', openSettings);
document.getElementById('cfg-close').addEventListener('click', closeSettings);
document.querySelector('.cfg-backdrop').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
});

document.getElementById('cfg-reset').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS, directions: { ...DEFAULT_SETTINGS.directions } };
    saveSettings();
    renderSettingsPanel();
    rerenderAll();
});

document.getElementById('cfg-body').addEventListener('input', (e) => {
    const input = e.target;
    if (input.dataset.setting) {
        const value = Number(input.value);
        const isWhole = input.step === '1';
        const valid = input.value !== '' && Number.isFinite(value)
            && value >= Number(input.min) && value <= Number(input.max)
            && (!isWhole || Number.isInteger(value));
        input.classList.toggle('invalid', !valid);
        if (!valid) return;
        settings[input.dataset.setting] = value;
    } else if (input.dataset.direction) {
        settings.directions[input.dataset.direction] = input.value;
    } else {
        return;
    }
    saveSettings();
    rerenderAll();
});

/**
 * INITIALIZATION
 */

function markUpdated() {
    document.getElementById('last-update').textContent = `LAST UPD ${formatTime(new Date())}`;
}

function renderCard(config) {
    const container = document.getElementById(config.id);
    container.innerHTML = buildMetricCard(config.data, config, container);
}

// Re-render from cached data; no refetch needed
function rerenderAll() {
    for (const config of Object.values(metrics)) {
        if (config.data) renderCard(config);
    }
    renderAlertStrip();
    renderRates();
}

function renderMetric(config, data) {
    if (config.data) {
        config.flash = config.type === 'divergence' ? 'same' : directionOf(last(config.data.closes), last(data.closes));
    }
    config.data = data;
    renderCard(config);
    renderAlertStrip();
    renderRates();
    markUpdated();
}

async function updateDashboardData() {
    // 1. Synchronously set loading placeholder for all empty containers
    for (const config of Object.values(metrics)) {
        const container = document.getElementById(config.id);
        if (container && container.children.length === 0) {
            container.innerHTML = renderPlaceholder(config, 'LOADING', 'CONNECTING TO MARKET DATA FEED...');
        }
    }

    // 2. Fetch and render all metric data sequentially to avoid rate-limiting the proxy
    for (const config of Object.values(metrics)) {
        const container = document.getElementById(config.id);
        if (!container) continue;

        try {
            const data = await config.generate();

            if (!data) {
                // If we never received data, show the offline warning
                if (!config.data) {
                    container.innerHTML = renderPlaceholder(config, 'OFFLINE', 'NO DATA RECEIVED — RETRYING');
                }
                // Schedule a delayed background retry to fetch this specific metric again in ~60 seconds (with jitter)
                setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
                continue;
            }

            renderMetric(config, data);
        } catch (e) {
            console.error(`Error updating metric ${config.id}:`, e);
            setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
        }

        // Add a polite 500ms delay between fetches to be respectful to Yahoo Finance's API
        await new Promise(r => setTimeout(r, 500));
    }
}

/**
 * Isolated background retry loop for a singular failed metric
 * Automatically respawns every ~60 seconds until a valid datapoint locks in
 */
async function retryFailedMetric(config) {
    const container = document.getElementById(config.id);
    if (!container) return;

    try {
        const data = await config.generate();
        if (data) {
            renderMetric(config, data);
        } else {
            // Still offline, queue another attempt
            setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
        }
    } catch (e) {
        setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
    }
}

function startClock() {
    const clock = document.getElementById('clock');
    const tick = () => {
        const now = new Date();
        clock.textContent = `${formatDate(now)} ${formatTime(now)}`;
    };
    tick();
    setInterval(tick, 1000);
}

async function initDashboard() {
    renderWindowBar();
    renderAlertStrip();
    startClock();
    if (activeWindow.intraday) startIntraday();
    await updateDashboardData();
    // Refresh the dashboard entirely silently every 15 minutes (900,000 ms)
    setInterval(updateDashboardData, 15 * 60 * 1000);
}

// Start processing on DOM load
document.addEventListener('DOMContentLoaded', initDashboard);
