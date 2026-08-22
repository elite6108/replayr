update public.games
set process_names = array[
  'GTA5.exe',
  'GTA5_Enhanced.exe',
  'GTAV.exe',
  'PlayGTAV.exe',
  '*GTAProcess.exe'
]
where slug = 'gta-v';
