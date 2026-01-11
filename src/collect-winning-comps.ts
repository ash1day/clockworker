import type { TftApi } from 'twisted'
import type { MatchTFTDTO } from 'twisted/dist/models-dto'
import { Divisions, type Regions as TwistedRegions } from 'twisted/dist/constants'

import { LEAGUE_API_RATE_LIMIT, MATCH_DETAIL_API_RATE_LIMIT, MATCH_LIST_API_RATE_LIMIT } from './common/constants'
import type { Region } from './common/types'
import { Regions, RegionToPlatform, Tiers } from './common/types'
import { batchGetWithFlowRestriction, createTftApi, REQUEST_BUFFER_RATE } from './utils/riot-api-utils'

// 収集対象リージョン
const TARGET_REGIONS: Region[] = [
  Regions.JAPAN,
  Regions.KOREA,
  Regions.NORTH_AMERICA,
  Regions.EU_WEST,
  Regions.EU_EAST,
  Regions.BRAZIL,
  Regions.LATIN_AMERICA_NORTH,
  Regions.LATIN_AMERICA_SOUTH,
  Regions.OCEANIA,
  Regions.TURKEY,
  Regions.VIETNAM
]

// 各リージョンから取得するトッププレイヤー数
const TOP_PLAYERS_COUNT = 10

// 各プレイヤーから取得する直近試合数
const RECENT_MATCHES_COUNT = 20

interface WinningComp {
  region: string
  playerName: string
  rank: number
  endAt: Date
  units: Array<{ character_id: string; tier: number }>
}

interface LeagueEntry {
  puuid: string
  summonerName?: string
  leaguePoints: number
  rank?: string
}

/**
 * タイムスタンプ付きログ出力
 */
function logWithTime(message: string): void {
  const now = new Date()
  const timestamp = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  console.log(`[${timestamp}] ${message}`)
}

/**
 * Challenger Leaderboardから上位N人を取得
 */
async function fetchTopChallengers(api: TftApi, region: Region, count: number): Promise<LeagueEntry[]> {
  const twistedRegion = region as unknown as TwistedRegions

  const league = await api.League.getChallengerLeague(twistedRegion)
  const entries = league.response.entries as LeagueEntry[]

  // LPで降順ソートして上位N人を取得
  return entries.sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, count)
}

/**
 * プレイヤーの直近試合から1位の試合を抽出
 * プレイヤー名は試合データから取得（riotIdGameName, riotIdTagline）
 */
async function fetchWinningMatches(
  api: TftApi,
  puuid: string,
  region: Region,
  rank: number
): Promise<{ comps: WinningComp[]; playerName: string }> {
  const regionGroup = RegionToPlatform[region]

  // 直近N試合のIDを取得
  let matchIds: string[] = []
  try {
    const matchList = await api.Match.list(puuid, regionGroup, { count: RECENT_MATCHES_COUNT })
    matchIds = matchList.response
  } catch (error) {
    console.warn(`  Failed to fetch match list: ${error}`)
    return { comps: [], playerName: 'Unknown' }
  }

  if (matchIds.length === 0) {
    return { comps: [], playerName: 'Unknown' }
  }

  // 試合詳細を取得
  const matchDetailWithParams = async (matchId: string, rg: typeof regionGroup) => {
    return api.Match.get(matchId, rg)
  }

  const matches = await batchGetWithFlowRestriction<MatchTFTDTO, [typeof regionGroup]>(
    matchDetailWithParams,
    matchIds,
    [regionGroup],
    MATCH_DETAIL_API_RATE_LIMIT,
    REQUEST_BUFFER_RATE
  )

  // プレイヤー名を最初の試合から取得
  let playerName = 'Unknown'
  if (matches.length > 0) {
    const firstParticipant = matches[0].info.participants.find((p) => p.puuid === puuid)
    if (firstParticipant) {
      const gameName = (firstParticipant as any).riotIdGameName || ''
      const tagLine = (firstParticipant as any).riotIdTagline || ''
      playerName = gameName || 'Unknown'
    }
  }

  // 1位の試合をフィルタ
  const winningComps: WinningComp[] = []

  for (const match of matches) {
    const participant = match.info.participants.find((p) => p.puuid === puuid)
    if (participant && participant.placement === 1) {
      winningComps.push({
        region,
        playerName,
        rank,
        endAt: new Date(match.info.game_datetime),
        units: participant.units.map((u) => ({
          character_id: u.character_id,
          tier: u.tier
        }))
      })
    }
  }

  return { comps: winningComps, playerName }
}

/**
 * 全リージョンからwinning compsを収集
 */
export async function collectWinningComps(): Promise<WinningComp[]> {
  const api = createTftApi()
  const allWinningComps: WinningComp[] = []

  for (const region of TARGET_REGIONS) {
    logWithTime(`Processing ${region}...`)

    try {
      // Challenger Top N を取得
      const topPlayers = await fetchTopChallengers(api, region, TOP_PLAYERS_COUNT)
      logWithTime(`  Found ${topPlayers.length} top challengers`)

      // 各プレイヤーの1位試合を取得
      for (let i = 0; i < topPlayers.length; i++) {
        const player = topPlayers[i]
        const rank = i + 1

        // 1位試合を取得（プレイヤー名も試合データから取得）
        const { comps, playerName } = await fetchWinningMatches(api, player.puuid, region, rank)
        allWinningComps.push(...comps)

        logWithTime(`  [${rank}] ${playerName} (${player.leaguePoints} LP) - ${comps.length} wins`)
      }
    } catch (error) {
      console.error(`Error processing ${region}:`, error)
      // エラーが発生しても他のリージョンは続行
    }
  }

  logWithTime(`Total winning comps collected: ${allWinningComps.length}`)
  return allWinningComps
}

/**
 * DBにwinning compsを保存（全削除→INSERT）
 */
export async function saveWinningCompsToDb(winningComps: WinningComp[]): Promise<void> {
  const { Pool } = await import('pg')

  const connectionString = process.env.TFTIPS_DATABASE_URL
  if (!connectionString) {
    throw new Error('TFTIPS_DATABASE_URL is not set')
  }

  const pool = new Pool({ connectionString })

  try {
    // 全削除
    await pool.query('TRUNCATE TABLE winning_comps RESTART IDENTITY')
    logWithTime('Truncated winning_comps table')

    // INSERT
    for (const comp of winningComps) {
      await pool.query(
        `INSERT INTO winning_comps (region, player_name, rank, end_at, units)
         VALUES ($1, $2, $3, $4, $5)`,
        [comp.region, comp.playerName, comp.rank, comp.endAt, JSON.stringify(comp.units)]
      )
    }

    logWithTime(`Inserted ${winningComps.length} winning comps`)
  } finally {
    await pool.end()
  }
}

/**
 * メイン処理
 */
export async function main(): Promise<void> {
  logWithTime('Starting winning comps collection...')

  const winningComps = await collectWinningComps()
  await saveWinningCompsToDb(winningComps)

  logWithTime('Done!')
}
