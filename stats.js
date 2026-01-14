#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const YAML = require('yaml');

// Parse args
const args = process.argv.slice(2);
const filterInterface = args.find(a => !a.endsWith('.yaml') && !a.endsWith('.yml'));
const configPath = args.find(a => a.endsWith('.yaml') || a.endsWith('.yml')) || path.join(__dirname, 'config.yaml');

const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));

const dbPath = config.settings.database.startsWith('.')
    ? path.join(__dirname, config.settings.database)
    : config.settings.database;

// Time periods to report
const periods = [
    { name: '5min',  secs: 5 * 60 },
    { name: '15min', secs: 15 * 60 },
    { name: '1hr',   secs: 60 * 60 },
    { name: '6hr',   secs: 6 * 60 * 60 },
    { name: '12hr',  secs: 12 * 60 * 60 },
    { name: '24hr',  secs: 24 * 60 * 60 },
    { name: '3d',    secs: 3 * 24 * 60 * 60 },
    { name: '7d',    secs: 7 * 24 * 60 * 60 },
    { name: '28d',   secs: 28 * 24 * 60 * 60 },
    { name: '3m',    secs: 90 * 24 * 60 * 60 },
];

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
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
    
    // Get list of interfaces from data
    const ifaceResult = db.exec(`SELECT DISTINCT interface_index, interface_name FROM samples ORDER BY interface_index`);
    if (!ifaceResult.length) {
        console.log('No data in database');
        process.exit(0);
    }
    
    let interfaces = ifaceResult[0].values.map(([idx, name]) => ({ index: idx, name }));
    
    // Filter to specific interface if requested
    if (filterInterface) {
        interfaces = interfaces.filter(i => i.name.toLowerCase() === filterInterface.toLowerCase());
        if (!interfaces.length) {
            console.error(`Interface '${filterInterface}' not found. Available:`, ifaceResult[0].values.map(v => v[1]).join(', '));
            process.exit(1);
        }
    }
    
    // Print header
    console.log('Traffic Statistics - ' + new Date().toISOString());
    console.log('='.repeat(80));
    
    for (const iface of interfaces) {
        console.log(`\n${iface.name.toUpperCase()}`);
        console.log('-'.repeat(80));
        console.log('Period'.padEnd(8) + 'RX'.padStart(14) + 'TX'.padStart(14) + 'RX Mbps'.padStart(12) + 'TX Mbps'.padStart(12));
        console.log('-'.repeat(80));
        
        for (const period of periods) {
            const since = now - period.secs;
            
            const result = db.exec(`
                SELECT 
                    MIN(timestamp) as t_start,
                    MAX(timestamp) as t_end,
                    MIN(in_octets) as in_start,
                    MAX(in_octets) as in_end,
                    MIN(out_octets) as out_start,
                    MAX(out_octets) as out_end
                FROM (
                    SELECT timestamp, in_octets, out_octets
                    FROM samples 
                    WHERE interface_index = ? AND timestamp >= ?
                    ORDER BY timestamp
                )
            `, [iface.index, since]);
            
            if (!result.length || !result[0].values[0][0]) {
                console.log(period.name.padEnd(8) + 'no data'.padStart(14));
                continue;
            }
            
            const [t_start, t_end, in_start, in_end, out_start, out_end] = result[0].values[0];
            const duration = t_end - t_start;
            
            if (duration <= 0) {
                console.log(period.name.padEnd(8) + 'no data'.padStart(14));
                continue;
            }
            
            const rxBytes = in_end - in_start;
            const txBytes = out_end - out_start;
            const rxMbps = (rxBytes * 8) / duration / 1000000;
            const txMbps = (txBytes * 8) / duration / 1000000;
            
            console.log(
                period.name.padEnd(8) +
                formatBytes(rxBytes).padStart(14) +
                formatBytes(txBytes).padStart(14) +
                rxMbps.toFixed(2).padStart(12) +
                txMbps.toFixed(2).padStart(12)
            );
        }
    }
    
    console.log('');
    db.close();
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
