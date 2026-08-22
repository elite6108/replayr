UPDATE games
SET process_names = '["GTA5.exe","GTA5_Enhanced.exe","GTAV.exe","PlayGTAV.exe","*GTAProcess.exe"]',
    updated_at = datetime('now')
WHERE slug = 'gta-v';
