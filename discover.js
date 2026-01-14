#!/usr/bin/env node

const snmp = require('net-snmp');

const host = process.argv[2];
const community = process.argv[3] || 'public';

if (!host) {
    console.error('Usage: ./discover.js <host> [community]');
    console.error('  e.g. ./discover.js 192.168.0.128 public');
    process.exit(1);
}

const OID_ifDescr = '1.3.6.1.2.1.2.2.1.2';

const session = snmp.createSession(host, community, {
    timeout: 5000,
    version: snmp.Version2c
});

const interfaces = [];

session.subtree(OID_ifDescr, (varbinds) => {
    for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) {
            console.error('Error:', snmp.varbindError(vb));
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
        console.error('SNMP error:', error.message);
        process.exit(1);
    }
    
    // Sort by index
    interfaces.sort((a, b) => a.index - b.index);
    
    // Print summary
    console.error(`Found ${interfaces.length} interfaces on ${host}\n`);
    
    // Output yaml
    console.log(`# Generated config for ${host}`);
    console.log(`# ${new Date().toISOString()}`);
    console.log('');
    console.log('device:');
    console.log(`  host: ${host}`);
    console.log(`  community: ${community}`);
    console.log('  version: 2c');
    console.log('  port: 161');
    console.log('  timeout: 5000');
    console.log('');
    console.log('interfaces:');
    
    for (const iface of interfaces) {
        // Comment out n/c (not connected) interfaces
        const prefix = iface.name.startsWith('n/c') ? '  # ' : '  ';
        console.log(`${prefix}- index: ${iface.index}`);
        console.log(`${prefix}  name: ${iface.name}`);
    }
    
    console.log('');
    console.log('settings:');
    console.log('  poll_interval: 30');
    console.log('  report_interval: 300');
    console.log('  database: ./traffic.sqlite');
});
