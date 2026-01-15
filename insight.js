#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const YAML = require('yaml');

// Parse args
const args = process.argv.slice(2);
const interfaceArg = args.find(a => !a.startsWith('-') && !a.endsWith('.yaml'));
const configPath = args.find(a => a.endsWith('.yaml') || a.endsWith('.yml')) || path.join(__dirname, 'config.yaml');

// Parse interval option (default 5m)
let intervalSecs = 5 * 60;
const intervalArg = args.find(a => a.startsWith('--interval=') || a.startsWith('-i='));
if (intervalArg) {
    const val = intervalArg.split('=')[1];
    if (val.endsWith('h')) intervalSecs = parseInt(val) * 60 * 60;
    else if (val.endsWith('m')) intervalSecs = parseInt(val) * 60;
    else intervalSecs = parseInt(val) * 60; // assume minutes
} else if (args.includes('--15m') || args.includes('-15m')) {
    intervalSecs = 15 * 60;
} else if (args.includes('--30m') || args.includes('-30m')) {
    intervalSecs = 30 * 60;
} else if (args.includes('--1h') || args.includes('-1h')) {
    intervalSecs = 60 * 60;
}

if (!interfaceArg) {
    console.error('Usage: ./insight.js <interface> [--interval=5m|15m|30m|1h]');
    console.error('  e.g. ./insight.js internet');
    console.error('  e.g. ./insight.js internet --interval=30m');
    console.error('  e.g. ./insight.js internet --1h');
    process.exit(1);
}

const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));

const dbPath = config.settings.database.startsWith('.')
    ? path.join(__dirname, config.settings.database)
    : config.settings.database;

// Get terminal width
const termWidth = process.stdout.columns || 120;
const graphWidth = Math.floor(termWidth * 0.75);
const graphHeight = 15;

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function formatRate(mbps) {
    if (mbps >= 1000) return (mbps / 1000).toFixed(1) + 'G';
    if (mbps >= 1) return mbps.toFixed(1) + 'M';
    return (mbps * 1000).toFixed(0) + 'K';
}

function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.toTimeString().substring(0, 5);
}

function formatDateTime(ts) {
    const d = new Date(ts * 1000);
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

async function main() {
    const SQL = await initSqlJs();
    
    if (!fs.existsSync(dbPath)) {
        console.error('Database not found:', dbPath);
        process.exit(1);
    }
    
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    
    // Find the interface
    const result = db.exec(`SELECT DISTINCT device_name, interface_index, interface_name FROM samples ORDER BY device_name`);
    if (!result.length) {
        console.log('No data in database');
        process.exit(0);
    }
    
    const allInterfaces = result[0].values.map(([device, idx, name]) => ({ device, index: idx, name }));
    const matches = allInterfaces.filter(i => i.name.toLowerCase().includes(interfaceArg.toLowerCase()));
    
    if (matches.length === 0) {
        console.error(`Interface '${interfaceArg}' not found.`);
        console.error('Available:', allInterfaces.map(i => `${i.device}/${i.name}`).join(', '));
        process.exit(1);
    }
    
    if (matches.length > 1) {
        // Check for exact match
        const exact = matches.find(i => i.name.toLowerCase() === interfaceArg.toLowerCase());
        if (exact) {
            matches.length = 0;
            matches.push(exact);
        } else {
            console.error(`Multiple interfaces match '${interfaceArg}':`);
            matches.forEach(i => console.error(`  ${i.device}/${i.name}`));
            process.exit(1);
        }
    }
    
    const iface = matches[0];
    
    // Calculate time range
    const now = Math.floor(Date.now() / 1000);
    const numSlots = graphWidth - 10; // Leave room for Y-axis labels
    const timeRange = numSlots * intervalSecs;
    const startTime = now - timeRange;
    
    // Align to interval boundaries
    const alignedEnd = Math.floor(now / intervalSecs) * intervalSecs;
    const alignedStart = alignedEnd - (numSlots * intervalSecs);
    
    // Get raw samples
    const samples = db.exec(`
        SELECT timestamp, in_octets, out_octets
        FROM samples
        WHERE device_name = ? AND interface_index = ? AND timestamp >= ?
        ORDER BY timestamp
    `, [iface.device, iface.index, alignedStart - intervalSecs]);
    
    if (!samples.length || samples[0].values.length < 2) {
        console.log(`Not enough data for ${iface.device}/${iface.name}`);
        process.exit(0);
    }
    
    const rows = samples[0].values;
    
    // Calculate rates per slot
    const slots = [];
    for (let i = 0; i < numSlots; i++) {
        const slotStart = alignedStart + (i * intervalSecs);
        const slotEnd = slotStart + intervalSecs;
        
        // Find samples that bracket this slot
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
    
    // Find max for Y-axis scaling
    let maxMbps = 0;
    let totalRxBytes = 0;
    let totalTxBytes = 0;
    let validSlots = 0;
    let firstValidTime = null;
    let lastValidTime = null;
    
    for (const slot of slots) {
        if (slot.rxMbps !== null) {
            maxMbps = Math.max(maxMbps, slot.rxMbps, slot.txMbps);
            totalRxBytes += slot.rxBytes || 0;
            totalTxBytes += slot.txBytes || 0;
            validSlots++;
            if (!firstValidTime) firstValidTime = slot.time;
            lastValidTime = slot.time + intervalSecs;
        }
    }
    
    if (maxMbps === 0) maxMbps = 1; // Avoid division by zero
    
    // Round up max to nice number
    const niceMax = Math.ceil(maxMbps * 1.1);
    
    // Build the graph
    const yAxisWidth = 8;
    const plotWidth = graphWidth - yAxisWidth;
    
    // Header
    console.log('');
    console.log(`  ${iface.device}/${iface.name} - ${intervalSecs / 60}min intervals`);
    console.log('  ' + '─'.repeat(graphWidth - 2));
    
    // Graph rows (top to bottom)
    for (let row = graphHeight - 1; row >= 0; row--) {
        const rowMinMbps = (row / graphHeight) * niceMax;
        const rowMaxMbps = ((row + 1) / graphHeight) * niceMax;
        
        // Y-axis label (only on some rows)
        let label = '';
        if (row === graphHeight - 1) {
            label = formatRate(niceMax).padStart(yAxisWidth - 2) + ' ┤';
        } else if (row === Math.floor(graphHeight / 2)) {
            label = formatRate(niceMax / 2).padStart(yAxisWidth - 2) + ' ┤';
        } else if (row === 0) {
            label = '0'.padStart(yAxisWidth - 2) + ' ┤';
        } else {
            label = ' '.repeat(yAxisWidth - 2) + ' │';
        }
        
        let line = label;
        
        for (let col = 0; col < plotWidth && col < slots.length; col++) {
            const slot = slots[col];
            if (slot.rxMbps === null) {
                line += ' ';
                continue;
            }
            
            const rxInRow = slot.rxMbps >= rowMinMbps && slot.rxMbps < rowMaxMbps;
            const txInRow = slot.txMbps >= rowMinMbps && slot.txMbps < rowMaxMbps;
            
            if (rxInRow && txInRow) {
                line += '*';
            } else if (rxInRow) {
                line += '-';
            } else if (txInRow) {
                line += '+';
            } else {
                line += ' ';
            }
        }
        
        console.log(line);
    }
    
    // X-axis
    console.log(' '.repeat(yAxisWidth - 1) + '└' + '─'.repeat(plotWidth));
    
    // Time labels
    let timeLabels = ' '.repeat(graphWidth);
    const numLabels = 6;
    const labelSpacing = Math.floor(plotWidth / numLabels);
    
    for (let i = 0; i <= numLabels; i++) {
        const slotIdx = Math.floor(i * labelSpacing);
        if (slotIdx < slots.length && slots[slotIdx] && slots[slotIdx].time) {
            const timeStr = formatTime(slots[slotIdx].time);
            const pos = yAxisWidth + slotIdx;
            if (pos + timeStr.length < graphWidth) {
                timeLabels = timeLabels.substring(0, pos) + timeStr + timeLabels.substring(pos + timeStr.length);
            }
        }
    }
    console.log(timeLabels);
    
    // Legend and stats
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
    db.close();
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
