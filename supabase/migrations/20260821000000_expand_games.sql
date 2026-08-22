insert into public.games (slug, name, publisher, process_names)
values
  ('league-of-legends', 'League of Legends', 'Riot Games', array['League of Legends.exe']),
  ('apex-legends', 'Apex Legends', 'Electronic Arts', array['r5apex.exe', 'r5apex_dx12.exe']),
  ('overwatch-2', 'Overwatch 2', 'Blizzard Entertainment', array['Overwatch.exe']),
  ('dota-2', 'Dota 2', 'Valve', array['dota2.exe']),
  ('pubg', 'PUBG: BATTLEGROUNDS', 'Krafton', array['TslGame.exe']),
  ('rainbow-six-siege', 'Rainbow Six Siege', 'Ubisoft', array['RainbowSix.exe', 'RainbowSix_Vulkan.exe']),
  ('rocket-league', 'Rocket League', 'Psyonix', array['RocketLeague.exe']),
  ('gta-v', 'Grand Theft Auto V', 'Rockstar Games', array['GTA5.exe', 'GTA5_Enhanced.exe']),
  ('roblox', 'Roblox', 'Roblox Corporation', array['RobloxPlayerBeta.exe']),
  ('minecraft-bedrock', 'Minecraft', 'Mojang Studios', array['Minecraft.Windows.exe']),
  ('elden-ring', 'Elden Ring', 'FromSoftware', array['eldenring.exe']),
  ('helldivers-2', 'Helldivers 2', 'Arrowhead Game Studios', array['helldivers2.exe']),
  ('palworld', 'Palworld', 'Pocketpair', array['Palworld-Win64-Shipping.exe']),
  ('destiny-2', 'Destiny 2', 'Bungie', array['destiny2.exe']),
  ('wow', 'World of Warcraft', 'Blizzard Entertainment', array['Wow.exe', 'WowClassic.exe']),
  ('ffxiv', 'Final Fantasy XIV', 'Square Enix', array['ffxiv_dx11.exe']),
  ('escape-from-tarkov', 'Escape from Tarkov', 'Battlestate Games', array['EscapeFromTarkov.exe']),
  ('baldurs-gate-3', 'Baldur''s Gate 3', 'Larian Studios', array['bg3.exe', 'bg3_dx11.exe']),
  ('marvel-rivals', 'Marvel Rivals', 'NetEase', array['Marvel-Win64-Shipping.exe'])
on conflict (slug) do update
set
  name = excluded.name,
  publisher = excluded.publisher,
  process_names = excluded.process_names;
