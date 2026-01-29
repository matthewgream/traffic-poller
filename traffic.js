#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const yaml = require('yaml');

const args = process.argv.slice(2);
const modeSummary = args.includes('--summary') || args.includes('-s');
const modeInsight = args.includes('--insight') || args.includes('-i');
const modeHourly = args.includes('--hourly') || args.includes('-H');
const configPath = args.find((a) => a.endsWith('.yaml') || a.endsWith('.yml')) || path.join(__dirname, 'config.yaml');
const filters = args.filter((a) => !a.endsWith('.yaml') && !a.endsWith('.yml') && !a.startsWith('-'));
let intervalSecs = 5 * 60;
const intervalArg = args.find((a) => a.startsWith('--interval='));
if (intervalArg) {
    const val = intervalArg.split('=')[1];
    if (val.endsWith('h')) intervalSecs = parseInt(val) * 60 * 60;
    else if (val.endsWith('m')) intervalSecs = parseInt(val) * 60;
    else intervalSecs = parseInt(val) * 60;
} else if (args.includes('--15m')) {
    intervalSecs = 15 * 60;
} else if (args.includes('--30m')) {
    intervalSecs = 30 * 60;
} else if (args.includes('--1h')) {
    intervalSecs = 60 * 60;
}
if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ./traffic.js [filter] [options]');
    console.log('');
    console.log('Modes:');
    console.log('  (default)      Detailed stats per interface');
    console.log('  --summary, -s  Compact table view');
    console.log('  --insight, -i  ASCII graph for single interface');
    console.log('  --hourly, -H   Time-of-day analysis');
    console.log('');
    console.log('Options:');
    console.log('  --interval=Xm  Graph interval: 5m, 15m, 30m, 1h (insight mode)');
    console.log('  --15m/--30m/--1h  Shorthand for interval');
    console.log('');
    console.log('Filter:');
    console.log('  <interface>         Match interface name');
    console.log('  <device>            Match device name');
    console.log('  <device>/<interface>  Exact match');
    console.log('');
    console.log('Examples:');
    console.log('  ./traffic.js                    # All interfaces, detailed');
    console.log('  ./traffic.js -s                 # All interfaces, summary');
    console.log('  ./traffic.js internet           # Filter to "internet"');
    console.log('  ./traffic.js internet -i        # Graph for "internet"');
    console.log('  ./traffic.js internet -i --1h   # Graph with 1h intervals');
    console.log('  ./traffic.js -H                 # Hourly summary all interfaces');
    console.log('  ./traffic.js internet -H        # Hourly detail for "internet"');
    process.exit(0);
}

if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
}
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
const dbPath = config.settings.database.startsWith('.') ? path.join(__dirname, config.settings.database) : config.settings.database;

const periods = [
    { name: '5m', secs: 5 * 60 },
    { name: '15m', secs: 15 * 60 },
    { name: '1h', secs: 60 * 60 },
    { name: '6h', secs: 6 * 60 * 60 },
    { name: '12h', secs: 12 * 60 * 60 },
    { name: '24h', secs: 24 * 60 * 60 },
    { name: '3d', secs: 3 * 24 * 60 * 60 },
    { name: '7d', secs: 7 * 24 * 60 * 60 },
    { name: '28d', secs: 28 * 24 * 60 * 60 },
    { name: '90d', secs: 90 * 24 * 60 * 60 },
];

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}
function formatMB(bytes) {
    if (bytes === null || bytes === undefined) return '-';
    const m = bytes / (1024 * 1024);
    return m >= 1000 ? (m / 1024).toFixed(1) + 'G' : m.toFixed(1) + 'M';
}
function formatRate(mbps) {
    if (mbps >= 1000) return (mbps / 1000).toFixed(1) + 'G';
    if (mbps >= 1) return mbps.toFixed(1) + 'M';
    return (mbps * 1000).toFixed(0) + 'K';
}
function formatRateShort(mbps) {
    if (mbps >= 100) return Math.round(mbps).toString();
    if (mbps >= 10) return mbps.toFixed(1);
    if (mbps >= 1) return mbps.toFixed(2);
    return (mbps * 1000).toFixed(0) + 'K';
}
function formatTime(ts) {
    return new Date(ts * 1000).toTimeString().substring(0, 5);
}
function formatDateTime(ts) {
    return new Date(ts * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function getAllInterfaces(db) {
    const result = db.exec(`SELECT DISTINCT device_name, interface_index, interface_name FROM samples ORDER BY device_name, interface_index`);
    return result.length ? result[0].values.map(([device, index, name]) => ({ device, index, name })) : [];
}

function filterInterfaces(items, filter) {
    if (!filter) return items;
    if (filter.includes('/')) {
        const [filterDevice, filterInterface] = filter.split('/');
        return items.filter((i) => i.device.toLowerCase() === filterDevice.toLowerCase() && i.name.toLowerCase() === filterInterface.toLowerCase());
    }
    const devices = items.filter((i) => i.device.toLowerCase() === filter.toLowerCase());
    const interfaces = items.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()));
    if (devices.length > 0) return devices;
    if (interfaces.length > 0) return interfaces;
    return [];
}

function getTraffic(db, device, ifaceIndex, since) {
    const result = db.exec(
        `
        SELECT 
            MIN(timestamp) as t_start,
            MAX(timestamp) as t_end,
            MIN(in_octets) as in_start,
            MAX(in_octets) as in_end,
            MIN(out_octets) as out_start,
            MAX(out_octets) as out_end,
            MIN(in_errors) as in_err_start,
            MAX(in_errors) as in_err_end,
            MIN(out_errors) as out_err_start,
            MAX(out_errors) as out_err_end
        FROM (
            SELECT timestamp, in_octets, out_octets, in_errors, out_errors
            FROM samples 
            WHERE device_name = ? AND interface_index = ? AND timestamp >= ?
            ORDER BY timestamp
        )
    `,
        [device, ifaceIndex, since]
    );
    if (!result.length || !result[0].values[0][0]) return null;
    const [t_start, t_end, in_start, in_end, out_start, out_end, in_err_start, in_err_end, out_err_start, out_err_end] = result[0].values[0];
    const duration = t_end - t_start;
    if (duration <= 0) return null;
    return {
        rx: in_end - in_start,
        tx: out_end - out_start,
        errors: (in_err_end || 0) - (in_err_start || 0) + ((out_err_end || 0) - (out_err_start || 0)),
        duration,
    };
}

function getHourlyRates(db, device, ifaceIndex) {
    const result = db.exec(
        `SELECT timestamp, in_octets, out_octets
         FROM samples
         WHERE device_name = ? AND interface_index = ?
         ORDER BY timestamp`,
        [device, ifaceIndex]
    );
    if (!result.length || result[0].values.length < 2) return null;
    const rows = result[0].values;
    const hourlyRates = {};
    for (let h = 0; h < 24; h++) hourlyRates[h] = { rx: [], tx: [] };
    for (let i = 1; i < rows.length; i++) {
        const [t1, in1, out1] = rows[i - 1];
        const [t2, in2, out2] = rows[i];
        const duration = t2 - t1;
        if (duration <= 0 || duration > 600) continue; // Skip gaps > 10min
        const rxBytes = in2 - in1;
        const txBytes = out2 - out1;
        if (rxBytes < 0 || txBytes < 0) continue; // Counter reset
        const rxMbps = (rxBytes * 8) / duration / 1000000;
        const txMbps = (txBytes * 8) / duration / 1000000;
        const midpoint = (t1 + t2) / 2;
        const hour = new Date(midpoint * 1000).getHours();
        hourlyRates[hour].rx.push(rxMbps);
        hourlyRates[hour].tx.push(txMbps);
    }
    return hourlyRates;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function calcStats(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const min = sorted[0];
    const max = sorted[n - 1];
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    if (n === 1) return { mean, ci: 0, stddev: 0, n, min, max, p50, p95, p99 };
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (n - 1);
    const stddev = Math.sqrt(variance);
    const tValues = { 2: 12.71, 3: 4.3, 4: 3.18, 5: 2.78, 6: 2.57, 7: 2.45, 8: 2.36, 9: 2.31, 10: 2.26, 15: 2.13, 20: 2.09, 30: 2.04 };
    let t = 1.96;
    for (const [df, tv] of Object.entries(tValues))
        if (n - 1 <= parseInt(df)) {
            t = tv;
            break;
        }
    const ci = t * (stddev / Math.sqrt(n));
    return { mean, ci, stddev, n, min, max, p50, p95, p99 };
}

function pad(str, len, right = false) {
    str = String(str);
    return right ? str.padEnd(len) : str.padStart(len);
}

function showHourlySummary(db, items) {
    const colWidth = 7;
    const nameWidth = 30;
    let header = 'Interface'.padEnd(nameWidth) + '│';
    for (let h = 0; h < 24; h++) header += pad(h.toString().padStart(2, '0'), colWidth);
    console.log('\n=== HOURLY TRAFFIC (avg Mbps rx/tx) ===\n');
    console.log(header);
    console.log('─'.repeat(nameWidth) + '┼' + '─'.repeat(24 * colWidth));
    for (const item of items) {
        const rates = getHourlyRates(db, item.device, item.index);
        if (!rates) continue;
        let line = `${item.device}/${item.name}`.substring(0, nameWidth - 1).padEnd(nameWidth) + '│';
        for (let h = 0; h < 24; h++) {
            const rxStats = calcStats(rates[h].rx);
            const txStats = calcStats(rates[h].tx);
            if (!rxStats || rxStats.n < 3) line += pad('-', colWidth);
            else line += pad(formatRateShort(rxStats.mean + txStats.mean), colWidth);
        }
        console.log(line);
    }
    console.log('');
}

function showHourlyDetailed(db, iface) {
    const rates = getHourlyRates(db, iface.device, iface.index);
    if (!rates) {
        console.log(`No data for ${iface.device}/${iface.name}`);
        return;
    }

    let maxP95 = 0;
    for (let h = 0; h < 24; h++) {
        const rxStats = calcStats(rates[h].rx);
        const txStats = calcStats(rates[h].tx);
        if (rxStats && rxStats.n >= 3) maxP95 = Math.max(maxP95, rxStats.p95);
        if (txStats && txStats.n >= 3) maxP95 = Math.max(maxP95, txStats.p95);
    }
    if (maxP95 === 0) maxP95 = 1;

    console.log(`\n=== HOURLY TRAFFIC: ${iface.device}/${iface.name} ===\n`);
    console.log('RX (Download) - Mbps');
    console.log('Hour  │   N   │   p50 │   p95 │   p99 │   Max │ Histogram');
    console.log('──────┼───────┼───────┼───────┼───────┼───────┼' + '─'.repeat(30));
    for (let h = 0; h < 24; h++) {
        const s = calcStats(rates[h].rx);
        const hourStr = h.toString().padStart(2, '0') + ':00';
        if (!s || s.n < 3) console.log(`${pad(hourStr, 5, true)} │     - │     - │     - │     - │     - │`);
        else
            console.log(
                `${pad(hourStr, 5, true)} │ ` +
                    `${pad(s.n, 5)} │ ` +
                    `${pad(s.p50.toFixed(2), 5)} │ ` +
                    `${pad(s.p95.toFixed(2), 5)} │ ` +
                    `${pad(s.p99.toFixed(2), 5)} │ ` +
                    `${pad(s.max.toFixed(2), 5)} │ ${'█'.repeat(Math.round((s.p95 / maxP95) * 25))}`
            );
    }
    console.log('\nTX (Upload) - Mbps');
    console.log('Hour  │   N   │   p50 │   p95 │   p99 │   Max │ Histogram');
    console.log('──────┼───────┼───────┼───────┼───────┼───────┼' + '─'.repeat(30));
    for (let h = 0; h < 24; h++) {
        const s = calcStats(rates[h].tx);
        const hourStr = h.toString().padStart(2, '0') + ':00';
        if (!s || s.n < 3) console.log(`${pad(hourStr, 5, true)} │     - │     - │     - │     - │     - │`);
        else
            console.log(
                `${pad(hourStr, 5, true)} │ ` +
                    `${pad(s.n, 5)} │ ` +
                    `${pad(s.p50.toFixed(2), 5)} │ ` +
                    `${pad(s.p95.toFixed(2), 5)} │ ` +
                    `${pad(s.p99.toFixed(2), 5)} │ ` +
                    `${pad(s.max.toFixed(2), 5)} │ ${'█'.repeat(Math.round((s.p95 / maxP95) * 25))}`
            );
    }

    const rxOverall = calcStats(Object.values(rates).flatMap((r) => r.rx));
    const txOverall = calcStats(Object.values(rates).flatMap((r) => r.tx));
    if (rxOverall && txOverall) {
        console.log('\n' + '─'.repeat(70));
        console.log(`Overall (${rxOverall.n} samples):`);
        console.log(`  RX: p50=${rxOverall.p50.toFixed(2)} p95=${rxOverall.p95.toFixed(2)} p99=${rxOverall.p99.toFixed(2)} Mbps`);
        console.log(`  TX: p50=${txOverall.p50.toFixed(2)} p95=${txOverall.p95.toFixed(2)} p99=${txOverall.p99.toFixed(2)} Mbps`);
    }

    console.log('');
}

function showSummary(db, items) {
    const now = Math.floor(Date.now() / 1000);
    const colWidth = 14;
    const nameWidth = 35;
    let header = 'Device/Interface'.padEnd(nameWidth);
    for (const period of periods) header += period.name.padStart(colWidth);
    console.log(header);
    console.log('='.repeat(nameWidth + periods.length * colWidth));
    for (const item of items) {
        let line = `${item.device}/${item.name}`.substring(0, nameWidth - 1).padEnd(nameWidth);
        for (const period of periods) {
            const traffic = getTraffic(db, item.device, item.index, now - period.secs);
            if (traffic) line += `${formatMB(traffic.rx)}/${formatMB(traffic.tx)}`.padStart(colWidth);
            else line += '-'.padStart(colWidth);
        }
        console.log(line);
    }
    console.log('');
}

function showDetailed(db, items) {
    const now = Math.floor(Date.now() / 1000);
    console.log('Traffic Statistics - ' + new Date().toISOString());
    console.log('='.repeat(90));
    const byDevice = {};
    for (const item of items) {
        if (!byDevice[item.device]) byDevice[item.device] = [];
        byDevice[item.device].push(item);
    }
    for (const [device, interfaces] of Object.entries(byDevice))
        for (const iface of interfaces) {
            console.log(`\n${device.toUpperCase()}/${iface.name.toUpperCase()}`);
            console.log('-'.repeat(90));
            console.log('Period'.padEnd(8) + 'RX'.padStart(14) + 'TX'.padStart(14) + 'RX Mbps'.padStart(12) + 'TX Mbps'.padStart(12) + 'Errors'.padStart(12));
            console.log('-'.repeat(90));
            for (const period of periods) {
                const traffic = getTraffic(db, device, iface.index, now - period.secs);
                if (!traffic) console.log(period.name.padEnd(8) + 'no data'.padStart(14));
                else {
                    const rxMbps = (traffic.rx * 8) / traffic.duration / 1000000;
                    const txMbps = (traffic.tx * 8) / traffic.duration / 1000000;
                    console.log(
                        period.name.padEnd(8) +
                            formatBytes(traffic.rx).padStart(14) +
                            formatBytes(traffic.tx).padStart(14) +
                            rxMbps.toFixed(2).padStart(12) +
                            txMbps.toFixed(2).padStart(12) +
                            (traffic.errors > 0 ? traffic.errors.toString() : '-').padStart(12)
                    );
                }
            }
        }
    console.log('');
}

function showInsight(db, iface) {
    const termWidth = process.stdout.columns || 120;
    const graphWidth = Math.floor(termWidth * 0.75);
    const graphHeight = 15;
    const now = Math.floor(Date.now() / 1000);
    const numSlots = graphWidth - 10;
    const timeRange = numSlots * intervalSecs;
    const alignedEnd = Math.floor(now / intervalSecs) * intervalSecs;
    const alignedStart = alignedEnd - numSlots * intervalSecs;
    const samples = db.exec(
        `
        SELECT timestamp, in_octets, out_octets
        FROM samples
        WHERE device_name = ? AND interface_index = ? AND timestamp >= ?
        ORDER BY timestamp
    `,
        [iface.device, iface.index, alignedStart - intervalSecs]
    );
    if (!samples.length || samples[0].values.length < 2) {
        console.log(`Not enough data for ${iface.device}/${iface.name}`);
        return;
    }
    const rows = samples[0].values;
    const slots = [];
    for (let i = 0; i < numSlots; i++) {
        const slotStart = alignedStart + i * intervalSecs;
        const slotEnd = slotStart + intervalSecs;
        let prevSample = null;
        let nextSample = null;
        for (let j = 0; j < rows.length; j++) {
            if (rows[j][0] <= slotStart) prevSample = rows[j];
            if (rows[j][0] >= slotEnd && !nextSample) nextSample = rows[j];
        }
        if (prevSample && nextSample && nextSample[0] > prevSample[0]) {
            const duration = nextSample[0] - prevSample[0];
            const rxBytes = nextSample[1] - prevSample[1];
            const txBytes = nextSample[2] - prevSample[2];
            const rxMbps = (rxBytes * 8) / duration / 1000000;
            const txMbps = (txBytes * 8) / duration / 1000000;
            slots.push({ time: slotStart, rxMbps, txMbps, rxBytes, txBytes });
        } else {
            slots.push({ time: slotStart, rxMbps: null, txMbps: null });
        }
    }

    let maxMbps = 0;
    let totalRxBytes = 0;
    let totalTxBytes = 0;
    let validSlots = 0;
    let firstValidTime = null;
    let lastValidTime = null;
    for (const slot of slots)
        if (slot.rxMbps !== null) {
            maxMbps = Math.max(maxMbps, slot.rxMbps, slot.txMbps);
            totalRxBytes += slot.rxBytes || 0;
            totalTxBytes += slot.txBytes || 0;
            validSlots++;
            if (!firstValidTime) firstValidTime = slot.time;
            lastValidTime = slot.time + intervalSecs;
        }
    if (maxMbps === 0) maxMbps = 1;
    const niceMax = Math.ceil(maxMbps * 1.1);

    const yAxisWidth = 8;
    const plotWidth = graphWidth - yAxisWidth;

    console.log('');
    console.log(`  ${iface.device}/${iface.name} - ${intervalSecs / 60}min intervals`);
    console.log('  ' + '─'.repeat(graphWidth - 2));

    for (let row = graphHeight - 1; row >= 0; row--) {
        const rowMinMbps = (row / graphHeight) * niceMax;
        const rowMaxMbps = ((row + 1) / graphHeight) * niceMax;
        let label = '';
        if (row === graphHeight - 1) label = formatRate(niceMax).padStart(yAxisWidth - 2) + ' ┤';
        else if (row === Math.floor(graphHeight / 2)) label = formatRate(niceMax / 2).padStart(yAxisWidth - 2) + ' ┤';
        else if (row === 0) label = '0'.padStart(yAxisWidth - 2) + ' ┤';
        else label = ' '.repeat(yAxisWidth - 2) + ' │';
        let line = label;
        for (let col = 0; col < plotWidth && col < slots.length; col++) {
            const slot = slots[col];
            if (slot.rxMbps === null) line += ' ';
            else {
                const rxInRow = slot.rxMbps >= rowMinMbps && slot.rxMbps < rowMaxMbps;
                const txInRow = slot.txMbps >= rowMinMbps && slot.txMbps < rowMaxMbps;
                if (rxInRow && txInRow) line += '*';
                else if (rxInRow) line += '-';
                else if (txInRow) line += '+';
                else line += ' ';
            }
        }
        console.log(line);
    }

    console.log(' '.repeat(yAxisWidth - 1) + '└' + '─'.repeat(plotWidth));

    let timeLabels = ' '.repeat(graphWidth);
    const numLabels = 6;
    const labelSpacing = Math.floor(plotWidth / numLabels);

    for (let i = 0; i <= numLabels; i++) {
        const slotIdx = Math.floor(i * labelSpacing);
        if (slotIdx < slots.length && slots[slotIdx] && slots[slotIdx].time) {
            const timeStr = formatTime(slots[slotIdx].time);
            const pos = yAxisWidth + slotIdx;
            if (pos + timeStr.length < graphWidth) timeLabels = timeLabels.substring(0, pos) + timeStr + timeLabels.substring(pos + timeStr.length);
        }
    }
    console.log(timeLabels);

    console.log('');
    console.log(`  Legend: - RX (in)  + TX (out)  * both`);
    console.log('  ' + '─'.repeat(graphWidth - 2));
    if (firstValidTime) {
        const duration = lastValidTime - firstValidTime;
        const avgRxMbps = validSlots > 0 ? (totalRxBytes * 8) / duration / 1000000 : 0;
        const avgTxMbps = validSlots > 0 ? (totalTxBytes * 8) / duration / 1000000 : 0;
        console.log(`  Time range: ${formatDateTime(firstValidTime)} → ${formatDateTime(lastValidTime)}`);
        console.log(`  Duration:   ${(duration / 3600).toFixed(1)} hours (${validSlots} samples)`);
        console.log(`  RX total:   ${formatBytes(totalRxBytes).padEnd(12)} avg: ${avgRxMbps.toFixed(2)} Mbps`);
        console.log(`  TX total:   ${formatBytes(totalTxBytes).padEnd(12)} avg: ${avgTxMbps.toFixed(2)} Mbps`);
    }

    console.log('');
}

async function main() {
    const SQL = await initSqlJs();
    if (!fs.existsSync(dbPath)) {
        console.error('Database not found:', dbPath);
        process.exit(1);
    }
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const interfaces = getAllInterfaces(db);
    if (!interfaces.length) {
        console.log('No data in database');
        process.exit(0);
    }
    const filter = filters[0] || null;
    let items = filterInterfaces(interfaces, filter);
    if (filter && !items.length) {
        console.error(`Filter '${filter}' not found.`);
        console.error(`  Devices: ${[...new Set(interfaces.map((i) => i.device))].join(', ')}`);
        console.error(`  Interfaces: ${[...new Set(interfaces.map((i) => i.name))].join(', ')}`);
        process.exit(1);
    }
    if (!items.length) items = interfaces;

    if (modeHourly) {
        if (filter && items.length === 1) {
            showHourlyDetailed(db, items[0]);
        } else if (filter && items.length > 1) {
            const exact = items.find((i) => i.name.toLowerCase() === filter.toLowerCase());
            if (exact) {
                showHourlyDetailed(db, exact);
            } else {
                showHourlySummary(db, items);
            }
        } else {
            showHourlySummary(db, items);
        }
    } else if (modeInsight) {
        if (items.length > 1) {
            const exact = items.find((i) => i.name.toLowerCase() === filter.toLowerCase());
            if (exact) items = [exact];
            else {
                console.error(`Multiple interfaces match '${filter}':`);
                items.forEach((i) => console.error(`  ${i.device}/${i.name}`));
                process.exit(1);
            }
        }
        showInsight(db, items[0]);
    } else if (modeSummary) {
        showSummary(db, items);
    } else {
        showDetailed(db, items);
    }
    db.close();
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
