/// Curated football teams + their tip destinations.
///
/// Each team advertises a "tip address" on chain, where a fan can send
/// USDt directly. In production those addresses would be verified by the
/// team's federation. For the hackathon we use hardcoded testnet addresses
/// so the demo flow works out of the box.
///
/// The idea is that anyone can browse teams, hit "Tip", and the amount
/// hits the team address in one signed tx from their WDK wallet. No
/// custodian, no server-held funds, the tip goes exactly where the fan
/// intended.

/// Each team has an ISO 3166-1 alpha-2 code so the frontend can render
/// flags from a reliable CDN (flagcdn.com serves SVG + PNG per country
/// code) instead of relying on OS-level emoji-flag fonts, which do not
/// render on Windows Chrome by default.
export const TEAMS = [
  {
    id: 'france',
    name: 'France',
    nickname: 'Les Bleus',
    iso: 'fr',
    color: '#0055A4',
    // Sepolia testnet demo addresses. Replace with the team's mainnet
    // treasury or federation wallet in production.
    tipAddress: '0x000000000000000000000000000000000000dEaD',
    players: [
      { name: 'Kylian Mbappé', role: 'forward', tipAddress: '0x0000000000000000000000000000000000000001' },
      { name: 'Antoine Griezmann', role: 'forward', tipAddress: '0x0000000000000000000000000000000000000002' },
      { name: 'Aurélien Tchouaméni', role: 'midfielder', tipAddress: '0x0000000000000000000000000000000000000003' },
    ],
  },
  {
    id: 'argentina',
    name: 'Argentina',
    nickname: 'La Albiceleste',
    iso: 'ar',
    color: '#75AADB',
    tipAddress: '0x000000000000000000000000000000000000bEEF',
    players: [
      { name: 'Lionel Messi', role: 'forward', tipAddress: '0x0000000000000000000000000000000000000004' },
      { name: 'Julián Álvarez', role: 'forward', tipAddress: '0x0000000000000000000000000000000000000005' },
      { name: 'Enzo Fernández', role: 'midfielder', tipAddress: '0x0000000000000000000000000000000000000006' },
    ],
  },
  {
    id: 'england',
    name: 'England',
    nickname: 'Three Lions',
    // No dedicated ISO code for England alone. gb-eng is the standard
    // subdivision code that flagcdn.com serves.
    iso: 'gb-eng',
    color: '#CE1124',
    tipAddress: '0x000000000000000000000000000000000000CAFE',
    players: [
      { name: 'Harry Kane', role: 'forward', tipAddress: '0x0000000000000000000000000000000000000007' },
      { name: 'Jude Bellingham', role: 'midfielder', tipAddress: '0x0000000000000000000000000000000000000008' },
      { name: 'Bukayo Saka', role: 'winger', tipAddress: '0x0000000000000000000000000000000000000009' },
    ],
  },
  {
    id: 'brazil',
    name: 'Brazil',
    nickname: 'Seleção',
    iso: 'br',
    color: '#009C3B',
    tipAddress: '0x000000000000000000000000000000000000BABE',
    players: [
      { name: 'Vinícius Júnior', role: 'winger', tipAddress: '0x000000000000000000000000000000000000000A' },
      { name: 'Rodrygo', role: 'winger', tipAddress: '0x000000000000000000000000000000000000000B' },
      { name: 'Casemiro', role: 'midfielder', tipAddress: '0x000000000000000000000000000000000000000C' },
    ],
  },
  {
    id: 'spain',
    name: 'Spain',
    nickname: 'La Roja',
    iso: 'es',
    color: '#AA151B',
    tipAddress: '0x000000000000000000000000000000000000C0DE',
    players: [
      { name: 'Lamine Yamal', role: 'forward', tipAddress: '0x000000000000000000000000000000000000000D' },
      { name: 'Rodri', role: 'midfielder', tipAddress: '0x000000000000000000000000000000000000000E' },
      { name: 'Pedri', role: 'midfielder', tipAddress: '0x000000000000000000000000000000000000000F' },
    ],
  },
  {
    id: 'germany',
    name: 'Germany',
    nickname: 'Die Mannschaft',
    iso: 'de',
    color: '#DD0000',
    tipAddress: '0x000000000000000000000000000000000000F00D',
    players: [
      { name: 'Florian Wirtz', role: 'midfielder', tipAddress: '0x0000000000000000000000000000000000000010' },
      { name: 'Jamal Musiala', role: 'midfielder', tipAddress: '0x0000000000000000000000000000000000000011' },
      { name: 'Kai Havertz', role: 'forward', tipAddress: '0x0000000000000000000000000000000000000012' },
    ],
  },
]

export function getTeam (id) {
  return TEAMS.find(t => t.id === id) || null
}

export function getPlayer (teamId, playerName) {
  const team = getTeam(teamId)
  if (!team) return null
  const p = team.players.find(x => x.name.toLowerCase() === String(playerName).toLowerCase())
  return p ? { ...p, teamId: team.id, teamName: team.name } : null
}

export function allTeamIds () {
  return TEAMS.map(t => t.id)
}
