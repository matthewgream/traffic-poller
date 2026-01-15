#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const YAML = require('yaml');

// Parse args
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary') || args.includes('-s');
const configPath = args.find(a => a.endsWith('.yaml') || a.endsWith('.yml')) || path.join(__dirname, 'config.yaml');
const filters = args.filter(a => !a.endsWith('.yaml') && !a.endsWith('.yml') && !a.startsWith('-'));

// Parse filter: can be "device", "device/interface", or "interface"
let filterDevice = null;
let filterInterface = null;

if (filters.length > 0) {
    const filter = filters[0];
    if (filter.includes('/')) {
        [filterDevice, filterInterface] = filter.split('/');
    } else {
        // Could be device or interface - we'll check against data
        filterDevice = filter;
        filterInterface = filter;
    }
}

const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));

const dbPath = config.settings.database.startsWith('.')
    ? path.join(__dirname, config.settings.database)
    : config.settings.database;

// Time periods to report
const periods = [
    { name: '5m',   secs: 5 * 60 },
    { name: '15m',  secs: 15 * 60 },
    { name: '1h',   secs: 60 * 60 },
    { name: '6h',   secs: 6 * 60 * 60 },
    { name: '12h',  secs: 12 * 60 * 60 },
    { name: '24h',  secs: 24 * 60 * 60 },
    { name: '3d',   secs: 3 * 24 * 60 * 60 },
    { name: '7d',   secs: 7 * 24 * 60 * 60 },
    { name: '28d',  secs: 28 * 24 * 60 * 60 },
    { name: '90d',  secs: 90 * 24 * 60 * 60 },
];

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function formatMB(bytes) {
    if (bytes === null || bytes === undefined) return '-';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1000) {
        return (mb / 1024).toFixed(1) + 'G';
    }
    return mb.toFixed(1) + 'M';
}

async function main() {
    const SQL = await initSqlJs();
    
    if (!fs.existsSync(dbPath)) {
        console.error('Database not found:', dbPath);
        process.exit(1);
    }
    
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    
    const now = Math.floor(Date.now() / 1000);
    
    // Get list of device/interfaces from data
    const result = db.exec(`SELECT DISTINCT device_name, interface_index, interface_name FROM samples ORDER BY device_name, interface_index`);
    if (!result.length) {
        console.log('No data in database');
        process.exit(0);
    }
    
    let items = result[0].values.map(([device, idx, name]) => ({ device, index: idx, name }));
    
    // Apply filters
    if (filters.length > 0) {
        const filter = filters[0];
        if (filter.includes('/')) {
            // Explicit device/interface filter
            items = items.filter(i => 
                i.device.toLowerCase() === filterDevice.toLowerCase() && 
                i.name.toLowerCase() === filterInterface.toLowerCase()
            );
        } else {
            // Try matching as device first, then interface
            const deviceMatches = items.filter(i => i.device.toLowerCase() === filter.toLowerCase());
            const interfaceMatches = items.filter(i => i.name.toLowerCase() === filter.toLowerCase());
            
            if (deviceMatches.length > 0) {
                items = deviceMatches;
            } else if (interfaceMatches.length > 0) {
                items = interfaceMatches;
            } else {
                const devices = [...new Set(result[0].values.map(v => v[0]))];
                const interfaces = [...new Set(result[0].values.map(v => v[2]))];
                console.error(`Filter '${filter}' not found.`);
                console.error(`  Devices: ${devices.join(', ')}`);
                console.error(`  Interfaces: ${interfaces.join(', ')}`);
                process.exit(1);
            }
        }
    }
    
    if (!items.length) {
        console.error('No matching device/interface found');
        process.exit(1);
    }
    
    // Helper to get traffic for a period
    function getTraffic(device, ifaceIndex, since) {
        const result = db.exec(`
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
        `, [device, ifaceIndex, since]);
        
        if (!result.length || !result[0].values[0][0]) {
            return null;
        }
        
        const [t_start, t_end, in_start, in_end, out_start, out_end, in_err_start, in_err_end, out_err_start, out_err_end] = result[0].values[0];
        const duration = t_end - t_start;
        
        if (duration <= 0) return null;
        
        return {
            rx: in_end - in_start,
            tx: out_end - out_start,
            errors: ((in_err_end || 0) - (in_err_start || 0)) + ((out_err_end || 0) - (out_err_start || 0)),
            duration
        };
    }
    
    if (summaryMode) {
        // Summary mode - compact table
        const colWidth = 14;
        const nameWidth = 35;
        
        // Header
        let header = 'Device/Interface'.padEnd(nameWidth);
        for (const period of periods) {
            header += period.name.padStart(colWidth);
        }
        
        console.log(header);
        console.log('='.repeat(nameWidth + periods.length * colWidth));
        
        for (const item of items) {
            let line = `${item.device}/${item.name}`.substring(0, nameWidth - 1).padEnd(nameWidth);
            
            for (const period of periods) {
                const since = now - period.secs;
                const traffic = getTraffic(item.device, item.index, since);
                
                if (traffic) {
                    const cell = `${formatMB(traffic.rx)}/${formatMB(traffic.tx)}`;
                    line += cell.padStart(colWidth);
                } else {
                    line += '-'.padStart(colWidth);
                }
            }
            
            console.log(line);
        }
        
        console.log('');
        db.close();
        return;
    }
    
    // Detailed mode (original)
    
    // Print header
    console.log('Traffic Statistics - ' + new Date().toISOString());
    console.log('='.repeat(90));
    
    // Group by device
    const byDevice = {};
    for (const item of items) {
        if (!byDevice[item.device]) byDevice[item.device] = [];
        byDevice[item.device].push(item);
    }
    
    for (const [device, interfaces] of Object.entries(byDevice)) {
        for (const iface of interfaces) {
            console.log(`\n${device.toUpperCase()}/${iface.name.toUpperCase()}`);
            console.log('-'.repeat(90));
            console.log('Period'.padEnd(8) + 'RX'.padStart(14) + 'TX'.padStart(14) + 'RX Mbps'.padStart(12) + 'TX Mbps'.padStart(12) + 'Errors'.padStart(12));
            console.log('-'.repeat(90));
            
            for (const period of periods) {
                const since = now - period.secs;
                
                const result = db.exec(`
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
                `, [device, iface.index, since]);
                
                if (!result.length || !result[0].values[0][0]) {
                    console.log(period.name.padEnd(8) + 'no data'.padStart(14));
                    continue;
                }
                
                const [t_start, t_end, in_start, in_end, out_start, out_end, in_err_start, in_err_end, out_err_start, out_err_end] = result[0].values[0];
                const duration = t_end - t_start;
                
                if (duration <= 0) {
                    console.log(period.name.padEnd(8) + 'no data'.padStart(14));
                    continue;
                }
                
                const rxBytes = in_end - in_start;
                const txBytes = out_end - out_start;
                const rxMbps = (rxBytes * 8) / duration / 1000000;
                const txMbps = (txBytes * 8) / duration / 1000000;
                const errors = ((in_err_end || 0) - (in_err_start || 0)) + ((out_err_end || 0) - (out_err_start || 0));
                
                console.log(
                    period.name.padEnd(8) +
                    formatBytes(rxBytes).padStart(14) +
                    formatBytes(txBytes).padStart(14) +
                    rxMbps.toFixed(2).padStart(12) +
                    txMbps.toFixed(2).padStart(12) +
                    (errors > 0 ? errors.toString() : '-').padStart(12)
                );
            }
        }
    }
    
    console.log('');
    db.close();
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
