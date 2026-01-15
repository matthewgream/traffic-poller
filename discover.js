#!/usr/bin/env node

const snmp = require('net-snmp');

const targets = process.argv.slice(2);

if (targets.length === 0) {
    console.error('Usage: ./discover.js <host[:community]> [host[:community]] ...');
    console.error('  e.g. ./discover.js 192.168.0.128');
    console.error('  e.g. ./discover.js 192.168.0.128:public 192.168.0.107:private');
    console.error('');
    console.error('Output is YAML config format. Redirect to save:');
    console.error('  ./discover.js 192.168.0.128 192.168.0.107 > config.yaml');
    process.exit(1);
}

const OID_ifDescr = '1.3.6.1.2.1.2.2.1.2';

function discoverDevice(host, community) {
    return new Promise((resolve, reject) => {
        const session = snmp.createSession(host, community, {
            timeout: 5000,
            version: snmp.Version2c
        });
        
        const interfaces = [];
        
        session.subtree(OID_ifDescr, (varbinds) => {
            for (const vb of varbinds) {
                if (snmp.isVarbindError(vb)) {
                    continue;
                }
                const oid = Array.isArray(vb.oid) ? vb.oid.join('.') : vb.oid.toString();
                const index = parseInt(oid.split('.').pop());
                const name = vb.value.toString();
                interfaces.push({ index, name });
            }
        }, (error) => {
            session.close();
            
            if (error) {
                reject(new Error(`${host}: ${error.message}`));
                return;
            }
            
            interfaces.sort((a, b) => a.index - b.index);
            resolve({ host, community, interfaces });
        });
    });
}

async function main() {
    const devices = [];
    
    for (const target of targets) {
        let host, community;
        if (target.includes(':')) {
            [host, community] = target.split(':');
        } else {
            host = target;
            community = 'public';
        }
        
        console.error(`Discovering ${host}...`);
        
        try {
            const result = await discoverDevice(host, community);
            devices.push(result);
            console.error(`  Found ${result.interfaces.length} interfaces`);
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
    
    if (devices.length === 0) {
        console.error('\nNo devices discovered');
        process.exit(1);
    }
    
    console.error('');
    
    // Output YAML
    console.log(`# Generated config for ${devices.length} device(s)`);
    console.log(`# ${new Date().toISOString()}`);
    console.log('');
    console.log('devices:');
    
    for (const device of devices) {
        // Generate a device name from last octet or hostname
        const nameParts = device.host.split('.');
        const deviceName = `device-${nameParts[nameParts.length - 1]}`;
        
        console.log(`  - name: ${deviceName}`);
        console.log(`    host: ${device.host}`);
        console.log(`    community: ${device.community}`);
        console.log('    interfaces:');
        
        for (const iface of device.interfaces) {
            const prefix = iface.name.startsWith('n/c') ? '      # ' : '      ';
            console.log(`${prefix}- index: ${iface.index}`);
            console.log(`${prefix}  name: ${iface.name}`);
        }
        console.log('');
    }
    
    console.log('settings:');
    console.log('  poll_interval: 30');
    console.log('  report_interval: 300');
    console.log('  database: ./traffic.sqlite');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
