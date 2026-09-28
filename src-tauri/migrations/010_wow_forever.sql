INSERT INTO games (slug, name, publisher, process_names) VALUES
('wow-forever', 'World of Warcraft: Forever', 'Blizzard Entertainment', '["WowClassicB.exe","WowClassicB-arm64.exe","WowB.exe","WowB-64.exe","WowB-ARM64.exe","WowForever.exe"]')
ON CONFLICT(slug) DO UPDATE SET
    name = excluded.name,
    publisher = excluded.publisher,
    process_names = excluded.process_names,
    updated_at = datetime('now');
