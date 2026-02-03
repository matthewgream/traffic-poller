sqlite3 -header -column traffic.sqlite "
SELECT 
    device_name || '/' || interface_name as interface,
    datetime(MIN(timestamp), 'unixepoch', 'localtime') as first,
    datetime(MAX(timestamp), 'unixepoch', 'localtime') as last,
    printf('%.1f', (MAX(timestamp)-MIN(timestamp))/86400.0) as days,
    COUNT(*) as n
FROM samples 
GROUP BY device_name, interface_index 
ORDER BY device_name, interface_index;
"
