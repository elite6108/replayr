CREATE TABLE games (
    slug TEXT PRIMARY KEY,
    cloud_id TEXT,
    name TEXT NOT NULL,
    publisher TEXT,
    cover_url TEXT,
    icon_url TEXT,
    process_names TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_games_cloud_id ON games(cloud_id);

INSERT INTO games (slug, name, publisher, process_names) VALUES
('fortnite', 'Fortnite', 'Epic Games', '["FortniteClient-Win64-Shipping.exe"]'),
('valorant', 'Valorant', 'Riot Games', '["VALORANT-Win64-Shipping.exe"]'),
('counter-strike-2', 'Counter-Strike 2', 'Valve', '["cs2.exe"]'),
('league-of-legends', 'League of Legends', 'Riot Games', '["League of Legends.exe"]'),
('apex-legends', 'Apex Legends', 'Electronic Arts', '["r5apex.exe","r5apex_dx12.exe"]'),
('overwatch-2', 'Overwatch 2', 'Blizzard Entertainment', '["Overwatch.exe"]'),
('dota-2', 'Dota 2', 'Valve', '["dota2.exe"]'),
('pubg', 'PUBG: BATTLEGROUNDS', 'Krafton', '["TslGame.exe"]'),
('rainbow-six-siege', 'Rainbow Six Siege', 'Ubisoft', '["RainbowSix.exe","RainbowSix_Vulkan.exe"]'),
('rocket-league', 'Rocket League', 'Psyonix', '["RocketLeague.exe"]'),
('gta-v', 'Grand Theft Auto V', 'Rockstar Games', '["GTA5.exe","GTA5_Enhanced.exe","GTAV.exe","PlayGTAV.exe","*GTAProcess.exe"]'),
('roblox', 'Roblox', 'Roblox Corporation', '["RobloxPlayerBeta.exe"]'),
('minecraft-bedrock', 'Minecraft', 'Mojang Studios', '["Minecraft.Windows.exe"]'),
('elden-ring', 'Elden Ring', 'FromSoftware', '["eldenring.exe"]'),
('helldivers-2', 'Helldivers 2', 'Arrowhead Game Studios', '["helldivers2.exe"]'),
('palworld', 'Palworld', 'Pocketpair', '["Palworld-Win64-Shipping.exe"]'),
('destiny-2', 'Destiny 2', 'Bungie', '["destiny2.exe"]'),
('wow', 'World of Warcraft', 'Blizzard Entertainment', '["Wow.exe","WowClassic.exe"]'),
('ffxiv', 'Final Fantasy XIV', 'Square Enix', '["ffxiv_dx11.exe"]'),
('escape-from-tarkov', 'Escape from Tarkov', 'Battlestate Games', '["EscapeFromTarkov.exe"]'),
('baldurs-gate-3', 'Baldur''s Gate 3', 'Larian Studios', '["bg3.exe","bg3_dx11.exe"]'),
('marvel-rivals', 'Marvel Rivals', 'NetEase', '["Marvel-Win64-Shipping.exe"]');
