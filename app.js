/**
 * Systemic Risk COP - Data Simulation and Visualization
 */

// Formatters
function formatCurrency(val) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}
function formatNumber(val) {
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

// Generate realistic random walk data to simulate last 12 months
function generateData(days, startValue, volatility, trend) {
    let current = startValue;
    const data = [];
    for (let i = 0; i < days; i++) {
        const normalRandom = (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 2;
        const dailyChange = current * (trend / 365) + current * volatility * normalRandom;
        current += dailyChange;
        
        if (current < 0.1) current = 0.1;
        data.push(current);
    }
    return data;
}

const DAYS = 365;

// API Helper for real data
async function fetchYahooData(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    // Using corsproxy.org which cleanly routes Yahoo Finance traffic without blocking Github Pages origins
    const proxyUrl = `https://corsproxy.org/?${encodeURIComponent(url)}`;
    try {
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`Proxy responded with ${res.status}`);
        
        // Parse as text first to avoid loud JSON SyntaxErrors in the console if the proxy returns a 502 HTML page
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            // Silently fail if the proxy returned an HTML error shield
            return null;
        }
        
        if (!data || !data.chart || !data.chart.result) return null;
        
        const result = data.chart.result[0];
        const closes = result.indicators.quote[0].close;
        const filtered = closes.filter(val => val !== null);
        // Only return if we have a robust dataset
        return filtered.length > 60 ? filtered : null;
    } catch (e) {
        // Suppress console spam so the dashboard silently enters its background retry loop
        return null;
    }
}

// Configuration for indicators
const metrics = {
    oil: {
        id: 'metric-oil',
        title: 'Crude Oil (WTI)',
        isLive: true,
        dataSource: 'Source: Yahoo Finance | Data refreshes every 15 minutes',
        formatter: formatCurrency,
        generate: async () => {
             return await fetchYahooData('CL=F');
        },
        type: 'standard'
    },
    soxx: {
        id: 'metric-soxx',
        title: 'Semiconductor ETF (SOXX)',
        isLive: true,
        dataSource: 'Source: Yahoo Finance | Data refreshes every 15 minutes',
        formatter: formatCurrency,
        generate: async () => {
             return await fetchYahooData('SOXX');
        },
        type: 'standard'
    },
    sp500div: {
        id: 'metric-sp500-divergence',
        title: 'Market Concentration',
        isLive: true,
        dataSource: 'Source: Yahoo Finance | Data refreshes every 15 minutes',
        formatter: formatNumber,
        generate: async () => {
             const spyData = await fetchYahooData('SPY');
             const rspData = await fetchYahooData('RSP');
             
             if (spyData && rspData) {
                 const minLength = Math.min(spyData.length, rspData.length);
                 const spyTrimmed = spyData.slice(-minLength);
                 const rspTrimmed = rspData.slice(-minLength);
                 
                 const spyStart = spyTrimmed[0];
                 const rspStart = rspTrimmed[0];
                 
                 const top10Live = spyTrimmed.map(val => (val / spyStart) * 100);
                 const ewLive = rspTrimmed.map(val => (val / rspStart) * 100);
                 
                 return { equalWeight: ewLive, top10: top10Live };
             }
             
             return null;
        },
        type: 'divergence'
    },
    treasury: {
        id: 'metric-treasury',
        title: '10-Year Treasury Yield',
        isLive: true,
        dataSource: 'Source: Yahoo Finance | Data refreshes every 15 minutes',
        formatter: (val) => formatNumber(val) + '%',
        generate: async () => {
             return await fetchYahooData('^TNX');
        },
        type: 'standard'
    },
    owl: {
        id: 'metric-owl',
        title: 'Blue Owl Capital (OWL)',
        isLive: true,
        dataSource: 'Source: Yahoo Finance | Data refreshes every 15 minutes',
        formatter: formatCurrency,
        generate: async () => {
             return await fetchYahooData('OWL');
        },
        type: 'standard'
    }
};

/**
 * UTILITY & MATH
 */

function calculateROC(data, daysAgo) {
    if (data.length < daysAgo) return 0;
    const current = data[data.length - 1];
    const past = data[data.length - daysAgo];
    return ((current - past) / past) * 100;
}

// Calculate Bollinger Bands / moving average channel
function calculateRollingBands(data, period = 60, multiplier = 2) {
    const bands = [];
    for (let i = 0; i < data.length; i++) {
        const sliceStart = Math.max(0, i - period + 1);
        const slice = data.slice(sliceStart, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
        const stdDev = Math.sqrt(variance);
        
        // If variance is 0 (first data point), give it a tiny buffer
        const sd = stdDev === 0 ? mean * 0.02 : stdDev;
        
        bands.push({ 
            upper: mean + multiplier * sd, 
            lower: mean - multiplier * sd,
            mean: mean
        });
    }
    return bands;
}

/**
 * VISUALIZATION SVG RENDERERS
 */

function renderSparkline(data, bands) {
    const width = 300;
    const height = 80;
    
    let min = Math.min(...data);
    let max = Math.max(...data);
    
    // Include bands to ensure they aren't clipped
    min = Math.min(min, ...bands.map(b => b.lower));
    max = Math.max(max, ...bands.map(b => b.upper));
    
    // Auto-scale padding
    const range = (max - min) || 1;
    min -= range * 0.1;
    max += range * 0.1;
    const adjustedRange = max - min;
    
    const scaleX = (i) => (i / (data.length - 1)) * width;
    const scaleY = (v) => height - ((v - min) / adjustedRange) * height;
    
    const pathData = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(d)}`).join(' ');
    
    // Dynamic Band Polygon
    const upperPath = bands.map((b, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(b.upper)}`).join(' ');
    const lowerPath = bands.slice().reverse().map((b, i) => `L ${scaleX(bands.length - 1 - i)} ${scaleY(b.lower)}`).join(' ');
    const bandPathData = `${upperPath} ${lowerPath} Z`;
    
    return `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <path class="svg-band" d="${bandPathData}"></path>
            <path class="svg-line" d="${pathData}"></path>
        </svg>
    `;
}

function renderDivergenceChart(dataObj) {
    const width = 800;
    const height = 180;
    
    const { top10, equalWeight } = dataObj;
    
    const min = Math.min(...top10, ...equalWeight);
    const max = Math.max(...top10, ...equalWeight);
    const range = (max - min) || 1;
    const dataLen = top10.length;
    
    const scaleX = (i) => (i / (dataLen - 1)) * width;
    const scaleY = (v) => height - ((v - min) / range) * height;
    
    const top10Path = top10.map((d, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(d)}`).join(' ');
    const ewPath = equalWeight.map((d, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(d)}`).join(' ');
    
    // Shaded divergence area
    const topAreaData = top10.map((d, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(d)}`).join(' ');
    const bottomAreaData = equalWeight.slice().reverse().map((d, i) => `L ${scaleX(dataLen - 1 - i)} ${scaleY(d)}`).join(' ');
    const shadedAreaPath = `${topAreaData} ${bottomAreaData} Z`;
    
    return `
        <div class="legend">
             <div class="legend-item"><div class="legend-color" style="background: #94a3b8; border: 1px dashed #94a3b8;"></div> S&P 500 Equal Weight</div>
             <div class="legend-item"><div class="legend-color" style="background: var(--line-color);"></div> S&P 500 Market-Cap Weight</div>
        </div>
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="height: calc(100% - 24px);">
            <path class="divergence-band" d="${shadedAreaPath}"></path>
            <path class="svg-line secondary-line" d="${ewPath}"></path>
            <path class="svg-line" d="${top10Path}"></path>
        </svg>
    `;
}

/**
 * COMPONENT GENERATION
 */

function buildMetricCard(metricData, config, container) {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const footerText = `${config.dataSource}. Last updated at ${timeString}`;

    if (config.type === 'divergence') {
        const { top10, equalWeight } = metricData;
        const currentT10 = top10[top10.length - 1];
        const currentEW = equalWeight[equalWeight.length - 1];
        const divergence = ((currentT10 - currentEW) / currentEW) * 100;
        
        const isValueAlert = Math.abs(divergence) > 15;
        if (isValueAlert && container) container.classList.add('alert');
        
        const story = isValueAlert 
            ? `Significant divergence present. Top 10 weights are pulling away from broader market average by ${divergence.toFixed(1)}%.` 
            : `Monitoring the performance spread between the top 10 megacap stocks and the broader equal-weight index.`;
            
        return `
            <div class="card-header">
                <div>
                    <div class="card-title-group">
                        <h3 class="card-title">${config.title}</h3>
                        ${config.isLive ? `<div class="live-indicator"><div class="live-dot"></div>LIVE</div>` : ''}
                    </div>
                    <p class="story-text ${isValueAlert ? 'alert-text' : ''}">${story}</p>
                </div>
            </div>
            <div class="chart-container">
                ${renderDivergenceChart(metricData)}
            </div>
            <div class="roc-container">
                <div class="roc-item">
                     <span class="roc-label">Divergence Spread</span>
                     <span class="roc-value ${isValueAlert ? 'alert-text' : ''}">${divergence > 0 ? '+' : ''}${divergence.toFixed(1)}%</span>
                </div>
            </div>
            <div class="data-source">${footerText}</div>
        `;
    }
    
    // Standard standard-metric evaluation
    const data = metricData;
    const current = data[data.length - 1];
    const roc30 = calculateROC(data, 30);
    const roc90 = calculateROC(data, 90);
    
    const bands = calculateRollingBands(data, 60, 2);
    const lastBand = bands[bands.length - 1];
    
    let isValueAlert = false;
    let isVelocityAlert = false;
    
    // Check if current point broke the moving channel
    if (current > lastBand.upper || current < lastBand.lower) {
        isValueAlert = true;
    }
    
    // Check for velocity spike
    if (Math.abs(roc30) > 15) {
        isVelocityAlert = true;
    }
    
    // VALUE alert changes the whole card border to red
    if (isValueAlert && container) {
        container.classList.add('alert');
    }
    
    let story = "Trading within historical 12-month range.";
    if (isValueAlert) {
         if (current > lastBand.upper) {
              story = "Trending significantly above 12-month historical averages. Strong upward momentum.";
         } else if (current < lastBand.lower) {
              story = "Trending significantly below 12-month historical averages. Strong downward momentum.";
         }
    } else if (isVelocityAlert) {
        // Only trigger this branch if it's NOT a value alert
        const direction = roc30 > 0 ? "upward" : "downward";
        story = `Price remains within historical bounds; flagging unusual 30-day ${direction} momentum.`;
    }
    
    return `
        <div class="card-header">
            <div>
                <div class="card-title-group">
                    <h3 class="card-title">${config.title}</h3>
                    ${config.isLive ? `<div class="live-indicator"><div class="live-dot"></div>LIVE</div>` : ''}
                </div>
                <p class="story-text ${isValueAlert || isVelocityAlert ? 'alert-text' : ''}">${story}</p>
            </div>
            <div class="card-value ${isValueAlert ? 'alert-text' : ''}">${config.formatter(current)}</div>
        </div>
        <div class="chart-container">
            ${renderSparkline(data, bands)}
        </div>
        <div class="roc-container">
            <div class="roc-item">
                 <span class="roc-label">30D Velocity</span>
                 <!-- Note: Velocity text is red if the velocity itself breaks 15%, regardless of value border -->
                 <span class="roc-value ${Math.abs(roc30) > 15 ? 'alert-text' : ''}">${roc30 > 0 ? '+' : ''}${roc30.toFixed(1)}%</span>
            </div>
            <div class="roc-item">
                 <span class="roc-label">90D Velocity</span>
                 <span class="roc-value ${Math.abs(roc90) > 15 ? 'alert-text' : ''}">${roc90 > 0 ? '+' : ''}${roc90.toFixed(1)}%</span>
            </div>
        </div>
        <div class="data-source">${footerText}</div>
    `;
}

/**
 * INITIALIZATION
 */

async function updateDashboardData() {
    // 1. Synchronously set loading placeholder for all empty containers
    for (const config of Object.values(metrics)) {
        const container = document.getElementById(config.id);
        if (container && container.children.length === 0) {
            container.innerHTML = `
                <div class="card-header">
                    <div>
                        <h3 class="card-title">${config.title}</h3>
                        <p class="story-text">Connecting to market data feed...</p>
                    </div>
                </div>
                <div class="chart-container" style="display: flex; align-items: center; justify-content: center;">
                    <p class="story-text" style="text-align: center; opacity: 0.5; max-width: 100%; font-size: 1rem;">Loading data...</p>
                </div>
            `;
        }
    }

    // 2. Fetch and render all metric data sequentially to avoid rate-limiting the free proxy
    for (const config of Object.values(metrics)) {
        const container = document.getElementById(config.id);
        if (!container) continue;
        
        try {
            const data = await config.generate();
            
            if (!data) {
                // If it failed and we never got past the loading state, show the offline warning
                if (container.innerHTML.includes('Connecting to market data feed...')) {
                    container.innerHTML = `
                        <div class="card-header">
                            <div>
                                <h3 class="card-title">${config.title}</h3>
                                <p class="story-text">Unable to connect. Automatically retrying...</p>
                            </div>
                        </div>
                        <div class="chart-container" style="display: flex; align-items: center; justify-content: center;">
                            <p class="story-text" style="text-align: center; opacity: 0.5; max-width: 100%; font-size: 1rem;">No data received</p>
                        </div>
                    `;
                }
                // Schedule a delayed background retry to fetch this specific metric again in ~60 seconds (with jitter)
                setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
                continue;
            }
            
            // Reset state
            container.classList.remove('alert');
            
            // Re-render entirely with updated dataset
            container.innerHTML = buildMetricCard(data, config, container);
        } catch (e) {
            console.error(`Error updating metric ${config.id}:`, e);
            setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
        }

        // Add a polite 500ms delay between fetches so the free proxy doesn't block us via CORS/Timeouts
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
            // Success! Remove error state and render the chart
            container.classList.remove('alert');
            container.innerHTML = buildMetricCard(data, config, container);
        } else {
            // Still offline, queue another attempt
            setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
        }
    } catch (e) {
        setTimeout(() => retryFailedMetric(config), 60000 + (Math.random() * 5000));
    }
}

async function initDashboard() {
    await updateDashboardData();
    // Refresh the dashboard entirely silently every 15 minutes (900,000 ms)
    setInterval(updateDashboardData, 15 * 60 * 1000);
}

// Start processing on DOM load
document.addEventListener('DOMContentLoaded', initDashboard);
