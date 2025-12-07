import type { TftApi } from 'twisted'
import type { MatchTFTDTO } from 'twisted/dist/models-dto'
import { MATCH_DETAIL_API_RATE_LIMIT, MATCH_LIST_API_RATE_LIMIT } from './common/constants'
import { Players } from './common/players'
import type { Region, Tier } from './common/types'
import { Regions, RegionToPlatform } from './common/types'
import {
  filterNewMatchIds,
  finalizeDataStore,
  initDataStore,
  saveMatchData,
  saveMatchIndex,
  uploadNewFilesNow
} from './s3-match-store'
import { gameVersionToPatchDir, patchToNumber } from './utils/patch-utils'
import { batchGetWithFlowRestriction, createTftApi, REQUEST_BUFFER_RATE } from './utils/riot-api-utils'

/**
 * タイムスタンプ付きログ出力
 */
function logWithTime(message: string): void {
  const now = new Date()
  const timestamp = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  console.log(`[${timestamp}] ${message}`)
}

/**
 * Playersからプレイヤー一覧を取得
 */
async function getPlayersFromCache(players: Players, region: Region, tiers: Tier[]): Promise<string[]> {
  console.log('  Loading players from cache...')

  const allPlayers = await players.getAllPlayers(region)
  console.log(`  Found ${allPlayers.length} cached players`)

  const filteredPlayers = allPlayers.filter((player) => tiers.includes(player.tier as Tier))
  if (filteredPlayers.length < allPlayers.length) {
    console.log(`  Filtered to ${filteredPlayers.length} players (based on cached tier data)`)
  }

  return filteredPlayers.map((player) => player.puuid)
}

/**
 * JPサーバーの上位プレイヤーから最新パッチを動的に検出
 */
async function detectLatestPatch(api: TftApi, players: Players): Promise<string> {
  logWithTime('Detecting latest patch from JP server...')

  // JPサーバーから200人のプレイヤーを取得
  const jpPlayers = await players.getAllPlayers(Regions.JAPAN)
  const samplePuuids = jpPlayers.slice(0, 200).map((p) => p.puuid)
  console.log(`  Sampling ${samplePuuids.length} players from JP...`)

  const regionGroup = RegionToPlatform[Regions.JAPAN]

  // 各プレイヤーの最新1試合を取得
  const matchListWithParams = async (puuid: string, rg: typeof regionGroup) => {
    return api.Match.list(puuid, rg, { count: 1 })
  }

  const matchIdArrays = await batchGetWithFlowRestriction<string[], [typeof regionGroup]>(
    matchListWithParams,
    samplePuuids,
    [regionGroup],
    MATCH_LIST_API_RATE_LIMIT,
    0.5
  )

  const matchIds = matchIdArrays.flat().slice(0, 50) // 50試合で十分
  console.log(`  Fetched ${matchIds.length} match IDs...`)

  // マッチ詳細を取得してパッチを抽出
  const matchDetailWithParams = async (matchId: string, rg: typeof regionGroup) => {
    return api.Match.get(matchId, rg)
  }

  const matches = await batchGetWithFlowRestriction<MatchTFTDTO, [typeof regionGroup]>(
    matchDetailWithParams,
    matchIds,
    [regionGroup],
    MATCH_DETAIL_API_RATE_LIMIT,
    0.5
  )

  // 最新パッチを特定
  let latestPatch = '0.0'
  let latestPatchNum = 0

  for (const match of matches) {
    try {
      const patch = gameVersionToPatchDir(match.info.game_version)
      const patchNum = patchToNumber(patch)
      if (patchNum > latestPatchNum) {
        latestPatchNum = patchNum
        latestPatch = patch
      }
    } catch {
      // ignore invalid version
    }
  }

  logWithTime(`Detected latest patch: ${latestPatch}`)
  return latestPatch
}

/**
 * リージョンからマッチを収集
 */
async function collectMatchesFromRegion(
  api: TftApi,
  players: Players,
  region: Region,
  tiers: Tier[],
  latestPatch: string,
  maxMatches?: number
): Promise<void> {
  const regionStart = Date.now()
  logWithTime(`Starting ${region} (patch: ${latestPatch})`)

  // PlayerCacheからプレイヤーを取得
  let uniquePuuids = await getPlayersFromCache(players, region, tiers)

  // マッチ数制限がある場合のみプレイヤー数を制限
  if (maxMatches) {
    const playersToFetch = Math.min(uniquePuuids.length, Math.ceil(maxMatches / 20))
    uniquePuuids = uniquePuuids.slice(0, playersToFetch)
    console.log(`  Limited to ${playersToFetch} players due to match limit`)
  }

  // マッチIDを取得（直近24時間のみ）
  const regionGroup = RegionToPlatform[region]
  const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000) // Unix timestamp in seconds

  const matchListWithParams = async (puuid: string, rg: typeof regionGroup) => {
    return api.Match.list(puuid, rg, { count: 100, startTime: oneDayAgo })
  }

  console.log('  Fetching match IDs from API...')
  const matchIdArrays = await batchGetWithFlowRestriction<string[], [typeof regionGroup]>(
    matchListWithParams,
    uniquePuuids,
    [regionGroup],
    MATCH_LIST_API_RATE_LIMIT,
    REQUEST_BUFFER_RATE
  )

  const allMatchIds = Array.from(new Set(matchIdArrays.flat()))
  console.log(`  Found ${allMatchIds.length} total match IDs from API`)

  // 既存のマッチIDと比較して新規のみフィルタリング（API呼び出し前に実施）
  const newMatchIds = await filterNewMatchIds(allMatchIds, region, latestPatch)

  if (newMatchIds.length === 0) {
    console.log(`  No new matches for ${latestPatch}`)
    const elapsed = Math.round((Date.now() - regionStart) / 1000)
    logWithTime(`Completed ${region} (${elapsed}s)`)
    return
  }

  // 新規マッチのみ詳細を取得
  const matchDetailWithParams = async (matchId: string, rg: typeof regionGroup) => {
    return api.Match.get(matchId, rg)
  }

  const matchIdsToFetch = maxMatches ? newMatchIds.slice(0, maxMatches) : newMatchIds
  console.log(`  Fetching ${matchIdsToFetch.length} new match details...`)
  const matches = await batchGetWithFlowRestriction<MatchTFTDTO, [typeof regionGroup]>(
    matchDetailWithParams,
    matchIdsToFetch,
    [regionGroup],
    MATCH_DETAIL_API_RATE_LIMIT,
    REQUEST_BUFFER_RATE
  )

  // 最新パッチのマッチのみフィルタリング（念のため確認）
  const newMatches: MatchTFTDTO[] = []

  for (const match of matches) {
    try {
      const patch = gameVersionToPatchDir(match.info.game_version)
      if (patch === latestPatch) {
        newMatches.push(match)
      }
    } catch (error) {
      console.warn('  Failed to parse patch from game version:', match.info.game_version, error)
    }
  }

  console.log(`  📊 Found ${newMatches.length} matches for patch ${latestPatch} (${matches.length} fetched)`)

  if (newMatches.length === 0) {
    console.log(`  No new matches found for latest patch ${latestPatch}`)
    const elapsed = Math.round((Date.now() - regionStart) / 1000)
    logWithTime(`Completed ${region} (${elapsed}s)`)
    return
  }

  const savedMatchIds = newMatches.map((m) => m.metadata.match_id)

  // データを保存してS3にアップロード
  await saveMatchData(newMatches, region, latestPatch)
  await saveMatchIndex(savedMatchIds, region, latestPatch)
  await uploadNewFilesNow()

  console.log(`  Saved ${newMatches.length} new matches for ${latestPatch}`)
  const elapsed = Math.round((Date.now() - regionStart) / 1000)
  logWithTime(`Completed ${region} (${elapsed}s, ${newMatches.length} matches)`)
}

/**
 * 全リージョンからマッチを収集
 */
export async function collectMatchesFromAllRegions(
  regions: Region[],
  tiers: Tier[],
  maxMatches?: number,
  skipDownload?: boolean,
  skipUpload?: boolean
): Promise<string> {
  const totalStart = Date.now()
  const api = createTftApi()
  const players = new Players()

  try {
    // S3から既存データをダウンロード（スキップオプションあり）
    if (!skipDownload) {
      logWithTime('Downloading from S3...')
      await initDataStore()
    } else {
      logWithTime('Skipping S3 download')
    }

    // 最新パッチを動的に検出
    const latestPatch = await detectLatestPatch(api, players)

    // 各リージョンからマッチを収集
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]
      logWithTime(`Progress: ${i + 1}/${regions.length} regions`)
      try {
        await collectMatchesFromRegion(api, players, region, tiers, latestPatch, maxMatches)
      } catch (error) {
        console.error(`Error collecting from ${region}:`, error)
        // エラーが発生してもほかのリージョンは続行
      }
    }

    // S3にアップロード（スキップオプションあり）
    if (!skipUpload) {
      logWithTime('Uploading all data to S3...')
      await finalizeDataStore(latestPatch)
    } else {
      logWithTime('Skipping S3 upload')
    }

    const totalElapsed = Math.round((Date.now() - totalStart) / 1000)
    const minutes = Math.floor(totalElapsed / 60)
    const seconds = totalElapsed % 60
    logWithTime(`All regions complete! Total time: ${minutes}m ${seconds}s`)

    return latestPatch
  } catch (error) {
    console.error('Fatal error during collection:', error)
    throw error
  }
}
