import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createReadStream } from 'node:fs'
import * as path from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Database } from 'duckdb-async'
import type { MatchTFTDTO } from 'twisted/dist/models-dto'
import * as zlib from 'zlib'

const BUCKET_NAME = 'tftips'
const PREFIX = 'match-data/'
const S3_REGION = 'ap-northeast-1'

// S3クライアント（遅延初期化）
let s3Client: S3Client | null = null
function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: S3_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      }
    })
  }
  return s3Client
}

/**
 * S3ベースのマッチデータストア
 *
 * フロー:
 * 1. S3から既存データをダウンロード
 * 2. 既存のマッチIDを読み込み
 * 3. 新規マッチのみAPI取得
 * 4. 新規ファイルのみS3にアップロード
 */

const DATA_DIR = process.cwd()

// 新規作成されたファイルを追跡（相対パス）
const newlyCreatedFiles: Set<string> = new Set()

/**
 * 新規作成されたファイルを取得
 */
export function getNewlyCreatedFiles(): string[] {
  return Array.from(newlyCreatedFiles)
}

/**
 * 新規作成ファイルリストをクリア
 */
export function clearNewlyCreatedFiles(): void {
  newlyCreatedFiles.clear()
}

/**
 * S3から既存データをダウンロード
 */
export async function downloadFromS3(downloadIndexes = false): Promise<void> {
  console.log('📥 Downloading existing data from S3...')
  try {
    const indexFlag = downloadIndexes ? ' --indexes' : ''
    execSync(`tsx src/sync-s3.ts download${indexFlag}`, { stdio: 'inherit', cwd: DATA_DIR })
    console.log('✅ Download complete')
  } catch (error) {
    console.warn('⚠️ Failed to download from S3 (may be first run):', error)
  }
}

/**
 * S3に単一ファイルをアップロード
 */
async function uploadFileToS3(localPath: string, key: string): Promise<void> {
  const fileStream = createReadStream(localPath)
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: PREFIX + key,
    Body: fileStream
  })

  await getS3Client().send(command)
}

/**
 * S3にデータをアップロード（新規作成ファイルのみ）
 */
export async function uploadToS3(_patch?: string): Promise<void> {
  const filesToUpload = getNewlyCreatedFiles()

  if (filesToUpload.length === 0) {
    console.log('📤 No new files to upload')
    return
  }

  console.log(`📤 Uploading ${filesToUpload.length} new files to S3...`)

  for (const file of filesToUpload) {
    const localPath = path.join(DATA_DIR, file)
    if (fs.existsSync(localPath)) {
      console.log(`  Uploading ${file}...`)
      await uploadFileToS3(localPath, file)
    } else {
      console.warn(`  ⚠️ File not found: ${file}`)
    }
  }

  console.log('✅ Upload complete')
  clearNewlyCreatedFiles()
}

/**
 * 新規作成ファイルを即座にS3にアップロードしてクリア
 */
export async function uploadNewFilesNow(): Promise<void> {
  const filesToUpload = getNewlyCreatedFiles()

  if (filesToUpload.length === 0) {
    return
  }

  for (const file of filesToUpload) {
    const localPath = path.join(DATA_DIR, file)
    if (fs.existsSync(localPath)) {
      console.log(`  📤 Uploading ${file}...`)
      await uploadFileToS3(localPath, file)
    }
  }

  clearNewlyCreatedFiles()
}

/**
 * 既存のマッチIDを取得
 */
export async function getExistingMatchIds(region: string, patch: string): Promise<Set<string>> {
  const indexPath = path.join(DATA_DIR, region, patch, 'index.json.gz')

  if (!fs.existsSync(indexPath)) {
    console.log(`  No existing index for ${region}/${patch}`)
    return new Set()
  }

  const compressed = fs.readFileSync(indexPath)
  const decompressed = zlib.gunzipSync(compressed)
  const matchIds = JSON.parse(decompressed.toString()) as string[]

  console.log(`  Found ${matchIds.length} existing matches in ${region}/${patch}`)
  return new Set(matchIds)
}

/**
 * 新規マッチIDをフィルタリング
 */
export async function filterNewMatchIds(matchIds: string[], region: string, patch: string): Promise<string[]> {
  const existingIds = await getExistingMatchIds(region, patch)
  const newIds = matchIds.filter((id) => !existingIds.has(id))

  console.log(`  ${newIds.length} new matches to fetch (${existingIds.size} already exist)`)
  return newIds
}

/**
 * タイムスタンプ文字列を取得 (YYYYMMDD-HHmmss)
 */
function getTimestampString(): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0].replace(/-/g, '')
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '')
  return `${date}-${time}`
}

/**
 * マッチデータを保存（Parquet形式、日付別ファイル）
 */
export async function saveMatchData(matches: MatchTFTDTO[], region: string, patch: string): Promise<void> {
  const dir = path.join(DATA_DIR, region, patch)
  fs.mkdirSync(dir, { recursive: true })

  const timestamp = getTimestampString()
  const parquetPath = path.join(dir, `${timestamp}.parquet`)

  console.log(`  Saving ${matches.length} matches to ${parquetPath}`)

  // DuckDBでParquetファイルを作成
  const db = await Database.create(':memory:')
  await db.run('INSTALL parquet; LOAD parquet;')

  // JSONをテーブルに読み込み
  const jsonPath = path.join(dir, 'temp_matches.json')
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(matches, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  )

  await db.run(`
    CREATE TABLE matches AS
    SELECT
      metadata,
      info
    FROM read_json('${jsonPath}',
      columns = {
        metadata: 'JSON',
        info: 'JSON'
      }
    )
  `)

  // Parquetとして保存
  await db.run(`COPY matches TO '${parquetPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`)

  await db.close()

  // 一時ファイルを削除
  fs.unlinkSync(jsonPath)

  // 新規作成ファイルとして追跡（相対パス）
  const relativePath = path.relative(DATA_DIR, parquetPath)
  newlyCreatedFiles.add(relativePath)

  console.log(`  ✅ Saved ${matches.length} matches to ${parquetPath}`)
}

/**
 * マッチインデックスを保存
 */
export async function saveMatchIndex(matchIds: string[], region: string, patch: string): Promise<void> {
  const dir = path.join(DATA_DIR, region, patch)
  fs.mkdirSync(dir, { recursive: true })

  const indexPath = path.join(dir, 'index.json.gz')

  // 既存のインデックスを読み込み
  let existingIds: string[] = []
  if (fs.existsSync(indexPath)) {
    const compressed = fs.readFileSync(indexPath)
    const decompressed = zlib.gunzipSync(compressed)
    existingIds = JSON.parse(decompressed.toString()) as string[]
  }

  // マージしてユニーク化
  const allIds = Array.from(new Set([...existingIds, ...matchIds]))

  // 圧縮して保存
  const compressed = zlib.gzipSync(
    JSON.stringify(allIds, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  )
  fs.writeFileSync(indexPath, compressed)

  // 新規作成ファイルとして追跡（相対パス）
  const relativePath = path.relative(DATA_DIR, indexPath)
  newlyCreatedFiles.add(relativePath)

  console.log(`  ✅ Saved ${allIds.length} match IDs to index`)
}

/**
 * データ収集プロセスの初期化
 */
export async function initDataStore(): Promise<void> {
  // S3から最新データをダウンロード（players + インデックス）
  await downloadFromS3(true)
}

/**
 * データ収集プロセスの完了
 */
export async function finalizeDataStore(patch?: string): Promise<void> {
  // S3にアップロード
  await uploadToS3(patch)
}

/**
 * プレイヤーデータを読み込み
 */
export async function loadPlayerData(region: string): Promise<any> {
  const filePath = path.join(DATA_DIR, region, 'players.json.gz')

  if (!fs.existsSync(filePath)) {
    return null
  }

  const compressed = fs.readFileSync(filePath)
  const decompressed = zlib.gunzipSync(compressed)
  return JSON.parse(decompressed.toString())
}

/**
 * プレイヤーデータを保存
 */
export async function savePlayerData(players: any[], region: string): Promise<void> {
  const dir = path.join(DATA_DIR, region)
  fs.mkdirSync(dir, { recursive: true })

  const filePath = path.join(dir, 'players.json.gz')
  const compressed = zlib.gzipSync(
    JSON.stringify(players, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  )
  fs.writeFileSync(filePath, compressed)

  // 新規作成ファイルとして追跡（相対パス）
  const relativePath = path.relative(DATA_DIR, filePath)
  newlyCreatedFiles.add(relativePath)

  console.log(`  ✅ Saved ${players.length} players to ${filePath}`)
}
