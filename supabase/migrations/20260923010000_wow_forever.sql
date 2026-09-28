insert into public.games (slug, name, publisher, process_names)
values (
  'wow-forever',
  'World of Warcraft: Forever',
  'Blizzard Entertainment',
  array[
    'WowClassicB.exe',
    'WowClassicB-arm64.exe',
    'WowB.exe',
    'WowB-64.exe',
    'WowB-ARM64.exe',
    'WowForever.exe'
  ]
)
on conflict (slug) do update
set
  name = excluded.name,
  publisher = excluded.publisher,
  process_names = excluded.process_names;
