#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const snmp = require('net-snmp');
const initSqlJs = require('sql.js');
const YAML = require('yaml');

// Parse command line args
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

function log(...args) {
    if (verbose) {
        console.log(new Date().toISOString(), ...args);
    }
}

function logError(...args) {
    console.error(new Date().toISOString(), 'ERROR:', ...args);
}

// Load configuration
const configPath = process.argv.find(a => a.endsWith('.yaml') || a.endsWith('.yml')) 
    || path.join(__dirname, 'config.yaml');

if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
}

const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
log('Loaded config from', configPath);

// OID definitions
const OIDs = {
    ifHCInOctets:    '1.3.6.1.2.1.31.1.1.1.6',
    ifHCOutOctets:   '1.3.6.1.2.1.31.1.1.1.10',
    ifHCInUcastPkts: '1.3.6.1.2.1.31.1.1.1.7',
    ifHCOutUcastPkts:'1.3.6.1.2.1.31.1.1.1.11',
    ifInErrors:      '1.3.6.1.2.1.2.2.1.14',
    ifOutErrors:     '1.3.6.1.2.1.2.2.1.20',
    ifOperStatus:    '1.3.6.1.2.1.2.2.1.8',
    ifHighSpeed:     '1.3.6.1.2.1.31.1.1.1.15'
};

// Database path
const dbPath = config.settings.database.startsWith('.') 
    ? path.join(__dirname, config.settings.database)
    : config.settings.database;

let db = null;
let sessions = {};
let pollInterval = null;
let reportInterval = null;

// Generate traffic report
function generateReport() {
    const now = Math.floor(Date.now() / 1000);
    const reportSecs = config.settings.report_interval || 300;
    const since = now - reportSecs;
    
    const parts = [];
    
    for (const device of config.devices) {
        for (const iface of device.interfaces) {
            const result = db.exec(`
                SELECT 
                    MIN(timestamp) as t_start,
                    MAX(timestamp) as t_end,
                    MIN(in_octets) as in_start,
                    MAX(in_octets) as in_end,
                    MIN(out_octets) as out_start,
                    MAX(out_octets) as out_end,
                    MIN(in_packets) as in_pkt_start,
                    MAX(in_packets) as in_pkt_end,
                    MIN(out_packets) as out_pkt_start,
                    MAX(out_packets) as out_pkt_end,
                    MIN(in_errors) as in_err_start,
                    MAX(in_errors) as in_err_end,
                    MIN(out_errors) as out_err_start,
                    MAX(out_errors) as out_err_end
                FROM (
                    SELECT timestamp, in_octets, out_octets, in_packets, out_packets, in_errors, out_errors
                    FROM samples 
                    WHERE device_name = ? AND interface_index = ? AND timestamp >= ?
                    ORDER BY timestamp
                )
            `, [device.name, iface.index, since]);
            
            if (result.length === 0 || !result[0].values[0][0]) {
                parts.push(`${device.name}/${iface.name}=no data`);
                continue;
            }
            
            const row = result[0].values[0];
            const [t_start, t_end, in_start, in_end, out_start, out_end, 
                   in_pkt_start, in_pkt_end, out_pkt_start, out_pkt_end,
                   in_err_start, in_err_end, out_err_start, out_err_end] = row;
            
            const duration = t_end - t_start;
            if (duration <= 0) {
                parts.push(`${device.name}/${iface.name}=no data`);
                continue;
            }
            
            const inBytes = in_end - in_start;
            const outBytes = out_end - out_start;
            const inPkts = (in_pkt_end || 0) - (in_pkt_start || 0);
            const outPkts = (out_pkt_end || 0) - (out_pkt_start || 0);
            const newInErrors = (in_err_end || 0) - (in_err_start || 0);
            const newOutErrors = (out_err_end || 0) - (out_err_start || 0);
            
            const inMbps = (inBytes * 8) / duration / 1000000;
            const outMbps = (outBytes * 8) / duration / 1000000;
            
            const mins = Math.round(duration / 60);
            let report = `${device.name}/${iface.name}=${mins}min rx:${formatBytesShort(inBytes)}(${inMbps.toFixed(2)}Mbps) tx:${formatBytesShort(outBytes)}(${outMbps.toFixed(2)}Mbps)`;
            
            if (newInErrors > 0 || newOutErrors > 0) {
                report += ` ERRORS:${newInErrors}in/${newOutErrors}out`;
            }
            
            parts.push(report);
        }
    }
    
    console.log(new Date().toISOString(), parts.join(', '));
}

function formatBytesShort(bytes) {
    if (bytes === 0) return '0B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

async function init() {
    const SQL = await initSqlJs();
    
    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
        log('Loaded existing database:', dbPath);
        
        // Check for old schema (no device_name column)
        const tableInfo = db.exec("PRAGMA table_info(samples)");
        if (tableInfo.length > 0) {
            const columns = tableInfo[0].values.map(row => row[1]);
            if (!columns.includes('device_name')) {
                console.log('Old schema detected, recreating database...');
                db.run('DROP TABLE IF EXISTS samples');
            }
        }
    } else {
        db = new SQL.Database();
        log('Created new database:', dbPath);
    }
    
    // Create tables with new schema
    db.run(`
        CREATE TABLE IF NOT EXISTS samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            device_name TEXT NOT NULL,
            device_host TEXT NOT NULL,
            interface_index INTEGER NOT NULL,
            interface_name TEXT NOT NULL,
            in_octets INTEGER NOT NULL,
            out_octets INTEGER NOT NULL,
            in_packets INTEGER NOT NULL DEFAULT 0,
            out_packets INTEGER NOT NULL DEFAULT 0,
            in_errors INTEGER NOT NULL DEFAULT 0,
            out_errors INTEGER NOT NULL DEFAULT 0,
            oper_status INTEGER NOT NULL,
            speed_mbps INTEGER NOT NULL
        )
    `);
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_timestamp ON samples(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_device ON samples(device_name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_device_interface ON samples(device_name, interface_index)`);
    
    saveDatabase();
    
    // Create SNMP sessions for each device
    for (const device of config.devices) {
        sessions[device.name] = snmp.createSession(device.host, device.community, {
            port: device.port || 161,
            timeout: device.timeout || 5000,
            version: snmp.Version2c
        });
        log(`SNMP session to ${device.name} (${device.host})`);
    }
    
    // Print startup info
    console.log(`SNMP Traffic Poller started`);
    console.log(`  Devices: ${config.devices.length}`);
    for (const device of config.devices) {
        console.log(`    ${device.name} (${device.host}): ${device.interfaces.map(i => i.name).join(', ')}`);
    }
    console.log(`  Poll interval: ${config.settings.poll_interval}s`);
    console.log(`  Database: ${dbPath}`);
    if (verbose) console.log('  Verbose mode enabled');
    console.log('');
    
    // Initial poll
    poll();
    
    // Schedule regular polling
    pollInterval = setInterval(poll, config.settings.poll_interval * 1000);
    
    // Schedule periodic reports
    const reportSecs = config.settings.report_interval || 300;
    if (reportSecs > 0) {
        console.log(`  Report interval: ${reportSecs}s`);
        reportInterval = setInterval(generateReport, reportSecs * 1000);
    }
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

function buildOidList(device) {
    const oids = [];
    for (const iface of device.interfaces) {
        oids.push(`${OIDs.ifHCInOctets}.${iface.index}`);
        oids.push(`${OIDs.ifHCOutOctets}.${iface.index}`);
        oids.push(`${OIDs.ifHCInUcastPkts}.${iface.index}`);
        oids.push(`${OIDs.ifHCOutUcastPkts}.${iface.index}`);
        oids.push(`${OIDs.ifInErrors}.${iface.index}`);
        oids.push(`${OIDs.ifOutErrors}.${iface.index}`);
        oids.push(`${OIDs.ifOperStatus}.${iface.index}`);
        oids.push(`${OIDs.ifHighSpeed}.${iface.index}`);
    }
    return oids;
}

function poll() {
    const timestamp = Math.floor(Date.now() / 1000);
    
    for (const device of config.devices) {
        const session = sessions[device.name];
        const oidList = buildOidList(device);
        
        session.get(oidList, (error, varbinds) => {
            if (error) {
                logError(`${device.name}: SNMP error:`, error.message);
                return;
            }
            
            const results = {};
            
            for (const vb of varbinds) {
                if (snmp.isVarbindError(vb)) {
                    logError(`${device.name}: Varbind error:`, snmp.varbindError(vb));
                    continue;
                }
                
                const oid = Array.isArray(vb.oid) ? vb.oid.join('.') : vb.oid.toString();
                const value = vb.value;
                const ifIndex = parseInt(oid.split('.').pop());
                
                if (!results[ifIndex]) {
                    results[ifIndex] = {};
                }
                
                if (oid.startsWith(OIDs.ifHCInOctets)) {
                    results[ifIndex].inOctets = bufferToNumber(value);
                } else if (oid.startsWith(OIDs.ifHCOutOctets)) {
                    results[ifIndex].outOctets = bufferToNumber(value);
                } else if (oid.startsWith(OIDs.ifHCInUcastPkts)) {
                    results[ifIndex].inPackets = bufferToNumber(value);
                } else if (oid.startsWith(OIDs.ifHCOutUcastPkts)) {
                    results[ifIndex].outPackets = bufferToNumber(value);
                } else if (oid.startsWith(OIDs.ifInErrors)) {
                    results[ifIndex].inErrors = value;
                } else if (oid.startsWith(OIDs.ifOutErrors)) {
                    results[ifIndex].outErrors = value;
                } else if (oid.startsWith(OIDs.ifOperStatus)) {
                    results[ifIndex].operStatus = value;
                } else if (oid.startsWith(OIDs.ifHighSpeed)) {
                    results[ifIndex].speedMbps = value;
                }
            }
            
            try {
                for (const iface of device.interfaces) {
                    const r = results[iface.index];
                    if (r && r.inOctets !== undefined && r.outOctets !== undefined) {
                        db.run(
                            `INSERT INTO samples (timestamp, device_name, device_host, interface_index, interface_name, in_octets, out_octets, in_packets, out_packets, in_errors, out_errors, oper_status, speed_mbps)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [timestamp, device.name, device.host, iface.index, iface.name, r.inOctets, r.outOctets, r.inPackets || 0, r.outPackets || 0, r.inErrors || 0, r.outErrors || 0, r.operStatus || 0, r.speedMbps || 0]
                        );
                        
                        let logMsg = `${device.name}/${iface.name}: in=${formatBytes(r.inOctets)} out=${formatBytes(r.outOctets)} pkts=${r.inPackets || 0}/${r.outPackets || 0}`;
                        if (r.inErrors || r.outErrors) {
                            logMsg += ` ERRORS=${r.inErrors}/${r.outErrors}`;
                        }
                        log(logMsg);
                    }
                }
                
                saveDatabase();
                log(`${device.name}: Stored ${Object.keys(results).length} samples`);
                
            } catch (err) {
                logError(`${device.name}: Database error:`, err.message);
            }
        });
    }
}

function bufferToNumber(buf) {
    if (typeof buf === 'number') return buf;
    if (Buffer.isBuffer(buf)) {
        if (buf.length <= 6) {
            return buf.readUIntBE(0, buf.length);
        } else {
            let val = 0n;
            for (const byte of buf) {
                val = (val << 8n) + BigInt(byte);
            }
            return Number(val);
        }
    }
    return 0;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function shutdown() {
    console.log('\nShutting down...');
    if (pollInterval) clearInterval(pollInterval);
    if (reportInterval) clearInterval(reportInterval);
    for (const name in sessions) {
        sessions[name].close();
    }
    if (db) {
        saveDatabase();
        db.close();
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

init().catch(err => {
    console.error('Failed to initialize:', err);
    process.exit(1);
});
